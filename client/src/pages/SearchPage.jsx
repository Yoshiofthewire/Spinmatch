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
  const [searchParams] = useSearchParams();
  const initialQuery = searchParams.get('q') ?? '';

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

  async function handleSearch(query) {
    setLoading(true);
    setError(null);
    try {
      const data = await get(`/search?q=${encodeURIComponent(query)}`);
      setResults(data);
    } catch (err) {
      setError(err);
      setResults(null);
    } finally {
      setLoading(false);
    }
  }

  // Runs the search once for a query arriving in the URL. Keyed on the param's
  // *value*, not on `searchParams` itself (a new object every render) or on
  // `handleSearch` (a new function every render) — either of those would fire
  // this on every render and hammer /search in a loop. Keying on the string
  // means it runs once on mount when `?q=` is present, and again only if the
  // value in the URL genuinely changes, never on an unrelated re-render.
  useEffect(() => {
    if (initialQuery) handleSearch(initialQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately keyed on the value, not on handleSearch's identity
  }, [initialQuery]);

  return (
    <div className="search-page">
      <SearchBox onSearch={handleSearch} loading={loading} initialValue={initialQuery} />

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
