// src/query.ts
//
// A small, zero-dependency "jq / MongoDB-ish" query engine over JSON documents:
//   - path get/set/projection  (dot + bracket index: "a.b[0].c")
//   - filter predicates        (Mongo-like: { age: { $gt: 18 }, $or: [...] })
//   - sort / skip / limit

export type Doc = unknown;

type Path = string | readonly (string | number)[];

export function tokenizePath(path: Path): (string | number)[] {
  if (Array.isArray(path)) return [...path];
  const tokens: (string | number)[] = [];
  for (const seg of String(path).split('.')) {
    let s = seg;
    while (s.length) {
      const m = s.match(/^([^[]*)\[(\d+)\](.*)$/);
      if (m) {
        if (m[1]) tokens.push(m[1]);
        tokens.push(Number(m[2]));
        s = m[3]!;
      } else {
        tokens.push(s);
        s = '';
      }
    }
  }
  return tokens;
}

/** getPath over an already-tokenized path (see compileMatch/compileProject). */
export function getPathTokens(doc: Doc, tokens: readonly (string | number)[]): unknown {
  let cur: unknown = doc;
  for (const t of tokens) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string | number, unknown>)[t];
  }
  return cur;
}

export function getPath(doc: Doc, path: Path): unknown {
  return getPathTokens(doc, tokenizePath(path));
}

export function setPath(obj: Doc, path: Path, value: unknown): Doc {
  const tokens = tokenizePath(path);
  let cur = obj as Record<string | number, unknown>;
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i]!;
    if (cur[t] === null || cur[t] === undefined || typeof cur[t] !== 'object') {
      cur[t] = typeof tokens[i + 1] === 'number' ? [] : {};
    }
    cur = cur[t] as Record<string | number, unknown>;
  }
  cur[tokens[tokens.length - 1]!] = value;
  return obj;
}

/** Keep only the given paths (inclusion). Returns a new object. */
export function project(doc: Doc, paths?: readonly string[]): Doc {
  if (!paths || !paths.length) return doc;
  return projectTokens(doc, paths.map(tokenizePath));
}

/** project() over paths tokenized once up front (see compileProject). */
export function projectTokens(doc: Doc, paths: readonly (readonly (string | number)[])[]): Doc {
  const out: Record<string, unknown> = {};
  for (const tokens of paths) {
    const v = getPathTokens(doc, tokens);
    if (v !== undefined) setPath(out, tokens, v);
  }
  return out;
}

/** Tokenize projection paths once for a per-document loop. Returns null for a
 *  missing/empty list, where project() is the identity (returns the doc). */
export function compileProject(paths?: readonly string[]): readonly (string | number)[][] | null {
  return paths && paths.length > 0 ? paths.map(tokenizePath) : null;
}

// --- filter --------------------------------------------------------------

type Cond = unknown;

function matchCond(val: unknown, cond: Cond): boolean {
  if (cond === null || typeof cond !== 'object' || cond instanceof RegExp) {
    if (cond instanceof RegExp) {
      // A caller-supplied RegExp with the global/sticky flag is stateful:
      // .test() advances lastIndex. Reset it so every document is tested from
      // the start instead of alternating match/miss across documents.
      cond.lastIndex = 0;
      return typeof val === 'string' && cond.test(val);
    }
    return val === cond;
  }
  for (const op of Object.keys(cond as Record<string, unknown>)) {
    const arg = (cond as Record<string, unknown>)[op];
    switch (op) {
      case '$eq':
        if (val !== arg) return false;
        break;
      case '$ne':
        if (val === arg) return false;
        break;
      case '$gt':
        if (!((val as number) > (arg as number))) return false;
        break;
      case '$gte':
        if (!((val as number) >= (arg as number))) return false;
        break;
      case '$lt':
        if (!((val as number) < (arg as number))) return false;
        break;
      case '$lte':
        if (!((val as number) <= (arg as number))) return false;
        break;
      case '$in':
        if (!Array.isArray(arg) || !arg.includes(val)) return false;
        break;
      case '$nin':
        if (!Array.isArray(arg) || arg.includes(val)) return false;
        break;
      case '$regex': {
        const re =
          arg instanceof RegExp ? arg : Array.isArray(arg) ? new RegExp(arg[0] as string, arg[1] as string | undefined) : new RegExp(arg as string);
        if (typeof val !== 'string') return false;
        // Reset a stateful (global/sticky) RegExp so a reused instance does not
        // carry lastIndex over from the previous document.
        re.lastIndex = 0;
        if (!re.test(val)) return false;
        break;
      }
      case '$exists':
        if ((val !== undefined) !== !!arg) return false;
        break;
      case '$contains':
        if (!Array.isArray(val) || !val.includes(arg)) return false;
        break;
      case '$type':
        if (typeof val !== arg) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

/** Does `doc` satisfy the Mongo-like `filter`? */
export function match(doc: Doc, filter?: Record<string, unknown> | null): boolean {
  return compileMatch(filter)(doc);
}

type Matcher = (doc: Doc) => boolean;

// One compiled clause per filter key, mirroring match()'s $-key handling
// exactly; path clauses carry the key's tokens so a per-document loop never
// re-tokenizes the same path.
type Clause =
  | { kind: 'path'; tokens: (string | number)[]; cond: Cond }
  | { kind: 'and'; subs: Matcher[] | null }
  | { kind: 'or'; subs: Matcher[] | null }
  | { kind: 'nor'; subs: Matcher[] | null }
  | { kind: 'not'; sub: Matcher };

/**
 * Compile a filter once for a per-document loop. The semantics are exactly
 * match()'s: clause order and short-circuiting are unchanged, and matchCond —
 * including its stateful-RegExp lastIndex reset — still runs per document.
 */
export function compileMatch(filter?: Record<string, unknown> | null): Matcher {
  const clauses: Clause[] = [];
  if (filter) {
    for (const key of Object.keys(filter)) {
      const cond = filter[key];
      if (key === '$and') {
        clauses.push({ kind: 'and', subs: Array.isArray(cond) ? cond.map((f) => compileMatch(f as Record<string, unknown>)) : null });
      } else if (key === '$or') {
        clauses.push({ kind: 'or', subs: Array.isArray(cond) ? cond.map((f) => compileMatch(f as Record<string, unknown>)) : null });
      } else if (key === '$nor') {
        clauses.push({ kind: 'nor', subs: Array.isArray(cond) ? cond.map((f) => compileMatch(f as Record<string, unknown>)) : null });
      } else if (key === '$not') {
        clauses.push({ kind: 'not', sub: compileMatch(cond as Record<string, unknown>) });
      } else {
        clauses.push({ kind: 'path', tokens: tokenizePath(key), cond });
      }
    }
  }
  if (clauses.length === 0) return () => true;
  return (doc) => {
    for (const c of clauses) {
      switch (c.kind) {
        case 'path':
          if (!matchCond(getPathTokens(doc, c.tokens), c.cond)) return false;
          break;
        case 'and':
          if (c.subs === null || !c.subs.every((s) => s(doc))) return false;
          break;
        case 'or':
          if (c.subs === null || !c.subs.some((s) => s(doc))) return false;
          break;
        case 'nor':
          if (c.subs === null || c.subs.some((s) => s(doc))) return false;
          break;
        case 'not':
          if (c.sub(doc)) return false;
          break;
      }
    }
    return true;
  };
}

