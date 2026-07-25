import { useEffect, useRef, useState } from 'react';

// Server-paged, server-filtered list state: the search box, its debounce, the
// page number, and the request that ties them together.
//
// Written once and shared by the tracks, artists and albums tabs. Artists and
// albums used to be fetched whole and filtered in the browser, which is fine at
// demo scale and a multi-megabyte response on every page load for a real
// collection — the same reason the tracks tab was paged from the start.
//
// `fetcher` is held in a ref rather than listed as a dependency: callers write it
// inline, so a fresh function identity every render would re-fire the request
// forever. The values that should trigger a refetch are the explicit deps below.
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
    // A disabled list is not a loading one. The initial state is 'loading', so
    // bailing out without touching it left a disabled list showing a spinner
    // with no path out of it — for as long as it stayed mounted.
    if (!enabled) {
      setState('ready');
      return undefined;
    }
    let cancelled = false;
    setState('loading');
    // Cleared here rather than only on success: a retry that succeeded still had
    // the previous failure's message sitting in `error`, ready to be rendered by
    // any consumer that reads it without checking `state` first.
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
