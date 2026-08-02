/**
 * Derive a session title from approved plan content.
 *
 * Plans front-load the goal ("# Refactor auth flow" followed by steps), so
 * the title comes from the head of the plan: the first markdown heading when
 * present, otherwise the first non-empty line. Markdown punctuation is
 * stripped and the result capped for picker display.
 */

const MAX_PLAN_SESSION_TITLE_LENGTH = 60;

const HEADING_PATTERN = /^#{1,6}\s+(.+)$/;
const MARKDOWN_PUNCTUATION_PATTERN = /[*_`~[\]()#>]/g;
const WHITESPACE_PATTERN = /\s+/g;

export function planSessionTitleFromPlan(plan: string): string | undefined {
  const lines = plan.split('\n');
  const heading = lines
    .map((line) => HEADING_PATTERN.exec(line.trim())?.[1])
    .find((match) => match !== undefined);
  const candidate = heading ?? lines.map((line) => line.trim()).find((line) => line.length > 0);
  if (candidate === undefined) return undefined;

  const cleaned = candidate
    .replace(MARKDOWN_PUNCTUATION_PATTERN, '')
    .replaceAll(WHITESPACE_PATTERN, ' ')
    .trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > MAX_PLAN_SESSION_TITLE_LENGTH
    ? `${cleaned.slice(0, MAX_PLAN_SESSION_TITLE_LENGTH - 1)}…`
    : cleaned;
}
