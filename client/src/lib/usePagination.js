import { useEffect, useState } from 'react';

// Slices `items` into pages of `pageSize`, resetting to page 1 whenever the
// underlying list changes (a new search, a different artist/album, etc.).
export function usePagination(items, pageSize = 20) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));

  useEffect(() => {
    setPage(1);
  }, [items]);

  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * pageSize;

  return {
    page: safePage,
    setPage,
    pageCount,
    pageItems: items.slice(start, start + pageSize),
  };
}
