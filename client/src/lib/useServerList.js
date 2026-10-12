import { useEffect, useRef, useState } from 'react';

// Server-paged, server-filtered list state (search, debounce, page).
// `fetcher` lives in a ref: callers pass it inline, so as a dep it would refetch forever.
export function useServerList({ fetcher, sort, pageSize = 100, enabled = true }) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [state, setState] = useState('loading'); // loading | ready | error
  const [error, setError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  // A new search or sort invalidates the current page number.
  useEffect(() => { setPage(1); }, [debounced, sort]);

  useEffect(() => {
    // Disabled is not loading; the initial 'loading' state would spin forever.
    if (!enabled) {
      setState('ready');
      return undefined;
    }
    let cancelled = false;
    setState('loading');
    // Clear before each request so a stale error can't outlive a successful retry.
    setError(null);
    fetcherRef.current({ q: debounced, sort, limit: pageSize, offset: (page - 1) * pageSize })
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setState('error');
      });
    return () => { cancelled = true; };
  }, [debounced, sort, page, pageSize, enabled, reloadKey]);

  return {
    query,
    setQuery,
    page,
    setPage,
    pageCount: data ? Math.max(Math.ceil(data.total / pageSize), 1) : 1,
    total: data?.total ?? 0,
    data,
    state,
    error,
    reload: () => setReloadKey((k) => k + 1),
  };
}
