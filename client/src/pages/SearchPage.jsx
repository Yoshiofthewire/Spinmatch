import { useTitle } from '../lib/useTitle.js';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get } from '../api/client.js';
import SearchBox from '../components/SearchBox.jsx';
import ResultsGroup from '../components/ResultsGroup.jsx';
import CoverArt from '../components/CoverArt.jsx';
import VerifyButton from '../components/VerifyButton.jsx';
import OwnedBadge from '../components/OwnedBadge.jsx';
import AddToPlaylistButton from '../components/AddToPlaylistButton.jsx';
import { useConfig } from '../ConfigContext.jsx';
import { useOwned } from '../lib/useOwned.js';

export default function SearchPage() {
  useTitle('Search');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const { libraryEnabled } = useConfig();
  // Query in the URL so Back/Forward and deep links work.
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get('q') ?? '';
  const [attempt, setAttempt] = useState(0);

  const { owned, error: ownedError } = useOwned({
    enabled: libraryEnabled,
    albums: (results?.releaseGroups ?? []).map((rg) => ({
      id: rg.mbid, artist: rg.artist, title: rg.title,
    })),
    recordings: (results?.recordings ?? []).map((r) => ({
      id: r.mbid, artist: r.artist, title: r.title,
    })),
  });

  // Submit writes the URL; the effect fetches. Same query bumps `attempt` instead.
  function handleSearch(next) {
    if (next === query) setAttempt((n) => n + 1);
    else setSearchParams({ q: next });
  }

  // Keyed on the string, not `searchParams` (new object every render).
  // `cancelled` drops stale responses.
  useEffect(() => {
    if (!query) {
      setResults(null);
      setError(null);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    get(`/search?q=${encodeURIComponent(query)}`)
      .then((data) => { if (!cancelled) setResults(data); })
      .catch((err) => {
        if (cancelled) return;
        setError(err);
        setResults(null);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [query, attempt]);

  return (
    <div className="search-page">
      <SearchBox onSearch={handleSearch} loading={loading} initialValue={query} />

      {error && <p className="banner banner-error">{error.message}</p>}
      {ownedError && <p className="muted">Couldn&apos;t check which results you own: {ownedError}</p>}

      {results && (
        <>
          <ResultsGroup
            title="Artists"
            items={results.artists}
            emptyText="No matching artists."
            renderItem={(a) => (
              <Link className="result-row" to={`/artist/${a.mbid}`}>
                <span>{a.name}</span>
                {a.disambiguation && <span className="muted"> — {a.disambiguation}</span>}
              </Link>
            )}
          />
          <ResultsGroup
            title="Albums"
            items={results.releaseGroups}
            emptyText="No matching albums."
            renderItem={(rg) => (
              <Link className="result-row" to={`/release-group/${rg.mbid}`}>
                <CoverArt src={rg.coverArtUrl} alt={rg.title} />
                <span>
                  {rg.title} <span className="muted">by {rg.artist}</span>
                </span>
                <OwnedBadge owned={owned.has(rg.mbid)} />
              </Link>
            )}
          />
          <ResultsGroup
            title="Songs"
            items={results.recordings}
            emptyText="No matching songs."
            renderItem={(r) => (
              <div className="result-row result-row-song">
                <span>
                  {r.title} <span className="muted">by {r.artist}</span>
                  <OwnedBadge owned={owned.has(r.mbid)} />
                </span>
                <VerifyButton artist={r.artist} title={r.title} album={r.releaseGroupTitle} lengthMs={r.lengthMs} />
                {libraryEnabled && (
                  <AddToPlaylistButton artist={r.artist} title={r.title} album={r.releaseGroupTitle} />
                )}
              </div>
            )}
          />
        </>
      )}
    </div>
  );
}
