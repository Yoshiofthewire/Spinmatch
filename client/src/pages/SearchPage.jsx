import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
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
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const navigate = useNavigate();
  const { libraryEnabled } = useConfig();
  // A link elsewhere in the app (a playlist gap row's "Find this track") can
  // land here with the search already decided.
  // The query lives in the URL so Back/Forward restore a search.
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get('q') ?? '';
  const [attempt, setAttempt] = useState(0);

  // The library knows instantly whether a result is already on disk, so say so
  // rather than making the user go and check.
  const owned = useOwned({
    enabled: libraryEnabled,
    albums: (results?.releaseGroups ?? []).map((rg) => ({
      id: rg.mbid, artist: rg.artist, title: rg.title,
    })),
    recordings: (results?.recordings ?? []).map((r) => ({
      id: r.mbid, artist: r.artist, title: r.title,
    })),
  });

  // Submitting only writes the URL; the effect below does the fetch. Re-submitting
  // the same query doesn't change the URL, so it bumps `attempt` instead.
  function handleSearch(next) {
    if (next === query) setAttempt((n) => n + 1);
    else setSearchParams({ q: next });
  }

  // Keyed on the param's string value, not `searchParams` (a new object every
  // render), so it fetches once per distinct query. `cancelled` drops a slow
  // response that lands after a newer search.
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

      {results && (
        <>
          <ResultsGroup
            title="Artists"
            items={results.artists}
            emptyText="No matching artists."
            renderItem={(a) => (
              <button className="result-row" onClick={() => navigate(`/artist/${a.mbid}`)}>
                <span>{a.name}</span>
                {a.disambiguation && <span className="muted"> — {a.disambiguation}</span>}
              </button>
            )}
          />
          <ResultsGroup
            title="Albums"
            items={results.releaseGroups}
            emptyText="No matching albums."
            renderItem={(rg) => (
              <button className="result-row" onClick={() => navigate(`/release-group/${rg.mbid}`)}>
                <CoverArt src={rg.coverArtUrl} alt={rg.title} />
                <span>
                  {rg.title} <span className="muted">by {rg.artist}</span>
                </span>
                <OwnedBadge owned={owned.has(rg.mbid)} />
              </button>
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
