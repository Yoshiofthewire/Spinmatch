export const MAX_PAGE_SIZE = 200;

// The floor matters: SQLite reads a negative LIMIT as unbounded.
export function positiveInt(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

export function paging(req, defaultLimit) {
  const offset = Number(req.query.offset);
  return {
    limit: positiveInt(req.query.limit, defaultLimit, MAX_PAGE_SIZE),
    offset: Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0,
  };
}
