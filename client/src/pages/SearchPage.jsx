import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get } from '../api/client.js';
import SearchBox from '../components/SearchBox.jsx';
import ResultsGroup from '../components/ResultsGroup.jsx';
import CoverArt from '../components/CoverArt.jsx';
import VerifyButton from '../components/VerifyButton.jsx';

export default function SearchPage() {
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const navigate = useNavigate();

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

  return (
    <div className="search-page">
      <SearchBox onSearch={handleSearch} loading={loading} />

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
                </span>
                <VerifyButton artist={r.artist} title={r.title} album={r.releaseGroupTitle} lengthMs={r.lengthMs} />
              </div>
            )}
          />
        </>
      )}
    </div>
  );
}
