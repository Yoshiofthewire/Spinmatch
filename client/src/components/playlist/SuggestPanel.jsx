import { useEffect, useState } from 'react';
import { getLibraryArtists } from '../../api/library.js';
import { suggestPlaylistTracks, addPlaylistItems } from '../../api/playlists.js';
import { formatDuration, formatBytes } from '../../lib/format.js';

// The sampler's own defaults (playlistFill.js MIN_DURATION_MS/MAX_DURATION_MS),
// duplicated here rather than fetched: the server already applies them when a
// request omits minMs/maxMs, so this only has to pre-fill the form with the
// same numbers, converted to units a person would type.
const DEFAULT_MIN_MS = 60_000;
const DEFAULT_MAX_MS = 720_000;

// Plain language for the sampler's four stop conditions (playlistFill.js).
// 'cap' and 'budget' are two different ways of saying "there was more to draw
// from, but a limit was reached first" — spelling out *which* limit is the
// whole value of this line, since either one reads as a bug from a bare count.
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

// Search-as-you-type over owned artists, with the chosen seeds shown as
// removable chips. Deliberately restricted to picking from the results rather
// than accepting free text: a seed the sampler can't resolve to a library
// artist just comes back with zero neighbours, which reads as a bug rather
// than a typo.
function SeedPicker({ seeds, onAdd, onRemove }) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [matches, setMatches] = useState([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
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
      .catch(() => { if (!cancelled) setMatches([]); })
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

// Discovery's proposal step: pick artists you own, draw tracks from the
// artists connected to them that you also own (collectNeighbours, the same
// signals the Discover tab uses), and review before anything is written.
//
// The suggest call itself writes nothing — POST /suggest is read-only by
// contract — so everything below the form is a client-side draft. Nothing
// reaches the playlist until "Add selected" runs.
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
  // The method that actually produced `result` — kept separate from the live
  // `method` radio so flipping Popular/Chance after a fetch, without
  // resubmitting, can't relabel a result's provenance or its Reshuffle
  // availability out from under it.
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
          // The method that produced a pick IS its source — 'popular' or
          // 'random' — the same vocabulary PlaylistDetail's SOURCE_LABELS
          // already renders as Popular/Chance. Read from submittedMethod, not
          // the live radio, so flipping it after the fetch can't mislabel
          // what's on screen.
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

        {/* preferPopular only changes anything for Chance — for Popular the
            fill is already strict popularity order (playlistFill.js orderFor),
            so the toggle would be a no-op that still looked like a choice. */}
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

          {/* This is the normal state right now — MetaBrainz's popularity
              endpoint answers 500 — so it reads as a note about how the list
              is ordered, not as a red "something broke" banner. */}
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
                {/* Popular's order is deterministic — re-posting would return the
                    same list, so a reshuffle only means something for Chance. */}
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
