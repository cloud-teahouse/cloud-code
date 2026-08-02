export interface Expandable {
  setExpanded(expanded: boolean): void;
}

/**
 * A transcript card that can be expanded individually by mouse click, as
 * opposed to the keyboard-driven global expansion behind `Expandable`. The
 * collapse-all pass of the keyboard toggle also clears these.
 */
export interface ClickExpandable {
  setClickExpanded(expanded: boolean): void;
}

export interface Disposable {
  dispose(): void;
}

export function isExpandable(obj: unknown): obj is Expandable {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'setExpanded' in obj &&
    typeof (obj as Expandable).setExpanded === 'function'
  );
}

export function isClickExpandable(obj: unknown): obj is ClickExpandable {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'setClickExpanded' in obj &&
    typeof (obj as ClickExpandable).setClickExpanded === 'function'
  );
}

export function hasDispose(value: unknown): value is Disposable {
  return (
    typeof value === 'object' &&
    value !== null &&
    'dispose' in value &&
    typeof (value as Disposable).dispose === 'function'
  );
}
