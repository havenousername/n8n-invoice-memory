// Parsing the Ask box and the over-plan threshold; both come from the browser, so neither is trusted.

export const MAX_QUERY_LENGTH = 200;

/** The query to embed, or null when there is nothing to ask. Long input is cut, never sent whole. */
export function normalizeQuery(text: string | null | undefined): string | null {
  const query = (text ?? '').replace(/\s+/g, ' ').trim();
  return query ? query.slice(0, MAX_QUERY_LENGTH) : null;
}

/** Euros over plan as a number, null for no threshold, or "invalid". Accepts 12000, 12,000, and 12 000. */
export function parseOver(text: string | null | undefined): number | null | 'invalid' {
  const raw = (text ?? '').trim();
  if (!raw) return null;
  if (!/^\d{1,3}([ ,]?\d{3})*$|^\d+$/.test(raw)) return 'invalid';
  const value = Number(raw.replace(/[ ,]/g, ''));
  return Number.isFinite(value) ? value : 'invalid';
}
