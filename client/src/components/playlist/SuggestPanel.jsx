import { useEffect, useState } from 'react';
import { getLibraryArtists } from '../../api/library.js';
import { suggestPlaylistTracks, addPlaylistItems } from '../../api/playlists.js';
import { formatDuration, formatBytes } from '../../lib/format.js';

// Mirrors playlistFill.js MIN/MAX_DURATION_MS, only to pre-fill the form.
const DEFAULT_MIN_MS = 60_000;
const DEFAULT_MAX_MS = 720_000;

// The sampler's stop conditions (playlistFill.js); name which limit was hit.
function stopReasonText(result, target) {
  const n = result.picked.length;
  const of = target != null ? ` of ${target}` : '';
  switch (result.stopped) {
    case 'cap':
      return `Filled ${n}${of}; the per-artist cap held the rest back.`;
    case 'budget':
      return `Filled ${n}${of}; the size limit stopped it there.`;
    case 'exhausted':
      return `Filled ${n}${of}; you don't own enough by these artists.`;
    case 'target':
    default:
      return `Filled ${n}${of} — the target was reached.`;
  }
}

// Pick-only, no free text: an unresolvable seed silently yields zero neighbours.
function SeedPicker({ seeds, onAdd, onRemove }) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [matches, setMatches] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    setSearchError(null);
    if (!debounced) {
      setMatches([]);
      return undefined;
    }
    let cancelled = false;
    setSearching(true);
    getLibraryArtists({ q: debounced, limit: 8 })
      .then((r) => {
        if (cancelled) return;
        setMatches(r.artists.filter((a) => !seeds.includes(a.artist)));
      })
      .catch((err) => {
        if (cancelled) return;
        setMatches([]);
        setSearchError(err.message);
      })
      .finally(() => { if (!cancelled) setSearching(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `seeds` only filters the already-fetched list; refetching on every pick would be wasted round trips
  }, [debounced]);

  return (
    <div className="suggest-seed-picker">
      <label className="suggest-field">
        Seed artists
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your library…"
          aria-label="Search your library for a seed artist"
        />
      </label>
      {searching && <span className="muted">Searching…</span>}
      {searchError && <p className="banner banner-error" role="alert">{searchError}</p>}
      {matches.length > 0 && (
        <ul className="suggest-seed-matches">
          {matches.map((a) => (
            <li key={a.artist}>
              <button
                type="button"
                className="chip-button"
                onClick={() => { onAdd(a.artist); setQuery(''); setMatches([]); }}
              >
                + {a.artist}
              </button>
            </li>
          ))}
        </ul>
      )}
      {seeds.length > 0 && (
        <ul className="suggest-seed-chosen">
          {seeds.map((s) => (
            <li key={s}>
              <span className="badge badge-source">{s}</span>
              <button type="button" className="link-button" onClick={() => onRemove(s)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// POST /suggest is read-only; nothing is written until "Add selected".
export default function SuggestPanel({ playlistId, onAdded }) {
  const [seeds, setSeeds] = useState([]);
  const [method, setMethod] = useState('popular'); // 'popular' | 'random'
  const [target, setTarget] = useState(50);
  const [sizeLimitMb, setSizeLimitMb] = useState('');
  const [preferPopular, setPreferPopular] = useState(false);
  const [minSeconds, setMinSeconds] = useState(DEFAULT_MIN_MS / 1000);
  const [maxMinutes, setMaxMinutes] = useState(DEFAULT_MAX_MS / 60_000);

  const [state, setState] = useState('idle'); // idle | loading | ready | error
  const [result, setResult] = useState(null);
  const [submittedTarget, setSubmittedTarget] = useState(null);
  // Method that produced `result`; flipping the radio afterwards must not relabel it.
  const [submittedMethod, setSubmittedMethod] = useState(null);
  const [error, setError] = useState(null);

  const [selected, setSelected] = useState(new Set()); // indices into result.picked
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(null);
  const [addedCount, setAddedCount] = useState(null);

  function buildOptions() {
    const mb = Number(sizeLimitMb);
    return {
      seedArtists: seeds,
      method,
      target: Math.max(1, Math.min(1000, Number(target) || 1)),
      byteBudget: sizeLimitMb.trim() && mb > 0 ? Math.round(mb * 1024 * 1024) : null,
      preferPopular,
      minMs: Math.max(0, Math.round((Number(minSeconds) || 0) * 1000)),
      maxMs: Math.max(0, Math.round((Number(maxMinutes) || 0) * 60_000)),
    };
  }

  async function runSuggest(e) {
    e?.preventDefault?.();
    if (seeds.length === 0) return;
    setState('loading');
    setError(null);
    setAddError(null);
    setAddedCount(null);
    const options = buildOptions();
    try {
      const data = await suggestPlaylistTracks(playlistId, options);
      setResult(data);
      setSubmittedTarget(options.target);
      setSubmittedMethod(options.method);
      setSelected(new Set(data.picked.map((_, i) => i)));
      setState('ready');
    } catch (err) {
      setError(err.message);
      setState('error');
    }
  }

  function toggleRow(i) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }

  function toggleAll() {
    if (!result) return;
    setSelected((prev) => (
      prev.size === result.picked.length ? new Set() : new Set(result.picked.map((_, i) => i))
    ));
  }

  async function addSelected() {
    if (!result || selected.size === 0) return;
    setAdding(true);
    setAddError(null);
    try {
      const items = result.picked
        .filter((_, i) => selected.has(i))
        .map((p) => ({
          artist: p.artist, title: p.title, album: p.album,
          // The producing method is the source (see PlaylistDetail SOURCE_LABELS).
          source: submittedMethod,
          seedArtist: p.seedArtist,
        }));
      await addPlaylistItems(playlistId, items);
      setAddedCount(items.length);
      setResult(null);
      setState('idle');
      onAdded?.();
    } catch (err) {
      setAddError(err.message);
    } finally {
      setAdding(false);
    }
  }

  const cap = result?.cap;

  return (
    <div className="suggest-panel">
      <p className="muted">
        Pick one or more artists you already own. This draws tracks you own by
        artists connected to them — the same signals as the Discover tab.
      </p>

      <SeedPicker
        seeds={seeds}
        onAdd={(a) => setSeeds((prev) => (prev.includes(a) ? prev : [...prev, a]))}
        onRemove={(a) => setSeeds((prev) => prev.filter((s) => s !== a))}
      />

      <form className="suggest-form" onSubmit={runSuggest}>
        <fieldset className="suggest-method">
          <legend>Method</legend>
          <label>
            <input
              type="radio"
              name="suggest-method"
              value="popular"
              checked={method === 'popular'}
              onChange={() => setMethod('popular')}
            />
            Popular
          </label>
          <label>
            <input
              type="radio"
              name="suggest-method"
              value="random"
              checked={method === 'random'}
              onChange={() => setMethod('random')}
            />
            Chance
          </label>
        </fieldset>

        <label className="suggest-field">
          Target tracks
          <input
            type="number"
            min="1"
            max="1000"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
        </label>

        <label className="suggest-field">
          Size limit (MB, optional)
          <input
            type="number"
            min="0"
            value={sizeLimitMb}
            onChange={(e) => setSizeLimitMb(e.target.value)}
            placeholder="No limit"
          />
        </label>

        {/* Popular is already popularity-ordered; the toggle only affects Chance. */}
        {method === 'random' && (
          <label className="suggest-checkbox">
            <input
              type="checkbox"
              checked={preferPopular}
              onChange={(e) => setPreferPopular(e.target.checked)}
            />
            Favour popular tracks within the shuffle
          </label>
        )}

        <details className="suggest-duration">
          <summary>Duration limits</summary>
          <label className="suggest-field">
            Shortest (seconds)
            <input
              type="number"
              min="0"
              value={minSeconds}
              onChange={(e) => setMinSeconds(e.target.value)}
            />
          </label>
          <label className="suggest-field">
            Longest (minutes)
            <input
              type="number"
              min="0"
              step="0.5"
              value={maxMinutes}
              onChange={(e) => setMaxMinutes(e.target.value)}
            />
          </label>
        </details>

        <div className="bulk-verify-actions">
          <button type="submit" disabled={seeds.length === 0 || state === 'loading'}>
            {state === 'loading' ? 'Finding tracks…' : 'Suggest tracks'}
          </button>
        </div>
      </form>

      {seeds.length === 0 && <p className="muted">Add at least one seed artist to suggest tracks.</p>}
      {state === 'error' && <p className="banner banner-error">{error}</p>}
      {addedCount != null && (
        <p className="banner banner-success">
          Added {addedCount} track{addedCount === 1 ? '' : 's'}.
        </p>
      )}

      {state === 'ready' && result && (
        <div className="suggest-results">
          <p className="muted">{stopReasonText(result, submittedTarget)}</p>
          {cap != null && <p className="muted">At most {cap} per artist.</p>}

          {/* Normal for now (upstream popularity endpoint 500s), so a note, not an error. */}
          {result.popularity === 'unavailable' && (
            <p className="banner banner-note">
              ListenBrainz popularity is unavailable, so these are ordered by release date instead.
            </p>
          )}

          {result.picked.length === 0 ? (
            <p className="muted">Nothing came back — try different seeds or loosen the duration limits.</p>
          ) : (
            <>
              <table className="library-table suggest-table">
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        checked={selected.size === result.picked.length}
                        onChange={toggleAll}
                        aria-label="Select all proposals"
                      />
                    </th>
                    <th>Artist</th>
                    <th>Title</th>
                    <th>Album</th>
                    <th>Length</th>
                    <th>Size</th>
                    <th>Via</th>
                  </tr>
                </thead>
                <tbody>
                  {result.picked.map((p, i) => (
                    <tr key={p.matchKey ?? `${p.artist}-${p.title}-${i}`}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(i)}
                          onChange={() => toggleRow(i)}
                          aria-label={`Include ${p.title}`}
                        />
                      </td>
                      <td>{p.artist}</td>
                      <td>{p.title}</td>
                      <td className="muted">{p.album ?? '—'}</td>
                      <td className="mono">{formatDuration(p.durationMs)}</td>
                      <td className="mono">{formatBytes(p.sizeBytes)}</td>
                      <td className="muted">{p.seedArtist ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {addError && <p className="banner banner-error">{addError}</p>}

              <div className="bulk-verify-actions">
                <button type="button" onClick={addSelected} disabled={selected.size === 0 || adding}>
                  {adding ? 'Adding…' : `Add selected (${selected.size})`}
                </button>
                {/* Popular is deterministic; reshuffle only for Chance. */}
                {submittedMethod === 'random' && (
                  <button
                    type="button"
                    className="chip-button"
                    onClick={runSuggest}
                    disabled={state === 'loading'}
                  >
                    Reshuffle
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
