import { useTitle } from '../lib/useTitle.js';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import EqualizerLoader from '../components/EqualizerLoader.jsx';
import ErrorBanner from '../components/ErrorBanner.jsx';
import Breadcrumbs from '../components/Breadcrumbs.jsx';
import OverviewTab from '../components/library/OverviewTab.jsx';
import ArtistsTab from '../components/library/ArtistsTab.jsx';
import AlbumsTab from '../components/library/AlbumsTab.jsx';
import TracksTab from '../components/library/TracksTab.jsx';
import IncompleteTab from '../components/library/IncompleteTab.jsx';
import HealthTab from '../components/library/HealthTab.jsx';
import DuplicatesTab from '../components/library/DuplicatesTab.jsx';
import ChangesTab from '../components/library/ChangesTab.jsx';
import DiscoveryPanel from '../components/library/DiscoveryPanel.jsx';
import ArtistDetail from '../components/library/ArtistDetail.jsx';
import AlbumDetail from '../components/library/AlbumDetail.jsx';
import PlayerBar from '../components/library/PlayerBar.jsx';
import { getLibraryStats, getIncompleteAlbums, getLibraryHealth, scanLibrary } from '../api/library.js';
import { albumKey } from '../lib/albumKey.js';

const TABS = [
  ['overview', 'Overview'],
  ['artists', 'Artists'],
  ['albums', 'Albums'],
  ['tracks', 'Tracks'],
  ['incomplete', 'Incomplete'],
  ['health', 'Health'],
  ['duplicates', 'Duplicates'],
  ['changes', 'Changes'],
  ['discover', 'Discover'],
];

export default function LibraryPage() {
  useTitle('Library');
  // Tab and drill-down live in the query string so Back works; query, not path,
  // params because names contain slashes.
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'overview';
  const selectedArtist = params.get('artist');
  const albumTitle = params.get('album');
  const albumArtist = params.get('albumArtist');

  // Last-clicked album row's extras; the URL carries only artist+album.
  const [albumMeta, setAlbumMeta] = useState(null);
  const selectedAlbum = useMemo(() => {
    if (!albumTitle) return null;
    const matches = albumMeta
      && albumMeta.album === albumTitle
      && (albumMeta.artist ?? null) === albumArtist;
    return matches ? albumMeta : { artist: albumArtist, album: albumTitle };
  }, [albumTitle, albumArtist, albumMeta]);

  const [stats, setStats] = useState(null);
  const [incomplete, setIncomplete] = useState([]);
  const [health, setHealth] = useState(null);

  const [artistSort, setArtistSort] = useState('name');
  const [albumSort, setAlbumSort] = useState('artist');

  const [state, setState] = useState('loading'); // loading | ready | error
  const [error, setError] = useState(null);
  const [scanning, setScanning] = useState(false);

  const [playing, setPlaying] = useState(null); // {track, queue}

  // showLoading=false for in-tab refreshes: the loading state would unmount the tab.
  async function load({ showLoading = true } = {}) {
    if (showLoading) setState('loading');
    setError(null);
    try {
      // Frame data only; each tab fetches its own pages.
      const [s, inc, h] = await Promise.all([
        getLibraryStats(),
        getIncompleteAlbums(),
        getLibraryHealth(),
      ]);
      setStats(s);
      setIncomplete(inc.albums);
      setHealth(h);
      setState('ready');
    } catch (err) {
      setError(err.message);
      setState('error');
    }
  }

  const refresh = () => load({ showLoading: false });

  useEffect(() => { load(); }, []);

  async function rescan() {
    setScanning(true);
    setError(null);
    try {
      await scanLibrary();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setScanning(false);
    }
  }

  // Set of "artist+album" keys used to badge incomplete albums in the grids.
  const incompleteKeys = useMemo(
    () => new Set(incomplete.filter((a) => a.reason === 'gaps').map((a) => albumKey(a.artist, a.album))),
    [incomplete],
  );

  // Each move pushes history. `replace` is for renames, whose old URL no longer resolves.
  function paramsFor({ tab: nextTab = tab, artist = null, album = null }) {
    const next = { tab: nextTab };
    if (artist) next.artist = artist;
    if (album) {
      next.album = album.album;
      if (album.artist) next.albumArtist = album.artist;
    }
    return next;
  }

  function go({ replace = false, ...where }) {
    setParams(paramsFor(where), { replace });
  }

  // Drill-downs are links to these; onClick only remembers the album row.
  const artistHref = (artist) => `?${new URLSearchParams(paramsFor({ artist }))}`;
  const albumHref = (album) => `?${new URLSearchParams(paramsFor({ artist: selectedArtist, album }))}`;

  function openArtist(artist) {
    go({ artist });
  }

  function openAlbum(album) {
    setAlbumMeta(album);
    go({ artist: selectedArtist, album });
  }

  // An album's identity is its (artist, album) pair, so a rename must update the URL.
  function albumRenamed(next) {
    const moved = { ...selectedAlbum, ...next };
    setAlbumMeta(moved);
    go({
      // Move the artist crumb too if that artist was renamed.
      artist: selectedArtist && selectedArtist === selectedAlbum.artist ? next.artist : selectedArtist,
      album: moved,
      replace: true,
    });
    refresh();
  }

  function clearSelection() {
    go({});
  }

  function switchTab(next) {
    go({ tab: next });
  }

  const crumbs = [{ label: 'Library', to: null }];
  if (selectedArtist) crumbs.push({ label: selectedArtist, to: null });
  if (selectedAlbum) crumbs.push({ label: selectedAlbum.album, to: null });

  return (
    <div className={`library-page${playing ? ' library-page-playing' : ''}`}>
      <h1>Your Library</h1>

      {error && <ErrorBanner message={error} onRetry={state === 'error' ? () => load() : undefined} />}
      {state === 'loading' && <EqualizerLoader label="Loading your library…" />}

      {state === 'ready' && (
        <>
          <div className="library-header">
            <nav className="library-tabs">
              {TABS.map(([key, label]) => {
                const active = tab === key && !selectedArtist;
                return (
                  <button
                    key={key}
                    type="button"
                    className={`library-tab${active ? ' library-tab-active' : ''}`}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => switchTab(key)}
                  >
                    {label}
                  </button>
                );
              })}
            </nav>
            <div className="library-scan">
              {stats.lastScanAt > 0 && (
                <span className="muted">
                  last scan {new Date(stats.lastScanAt).toLocaleString()}
                </span>
              )}
              <button type="button" onClick={rescan} disabled={scanning}>
                {scanning ? 'Scanning…' : 'Rescan library'}
              </button>
            </div>
          </div>

          {(selectedArtist || selectedAlbum) && (
            <div className="library-back">
              <Breadcrumbs crumbs={crumbs} />
              <button type="button" className="link-button" onClick={clearSelection}>
                ← Back to {TABS.find(([k]) => k === tab)?.[1]}
              </button>
            </div>
          )}

          {selectedAlbum ? (
            <AlbumDetail
              album={selectedAlbum}
              onPlay={(track, queue) => setPlaying({ track, queue })}
              onSelectArtist={openArtist}
              onLibraryChanged={refresh}
              onAlbumRenamed={albumRenamed}
            />
          ) : selectedArtist ? (
            <ArtistDetail
              artist={selectedArtist}
              onSelectAlbum={setAlbumMeta}
              albumHref={albumHref}
              incompleteKeys={incompleteKeys}
              onLibraryChanged={refresh}
            />
          ) : (
            <>
              {tab === 'overview' && (
                <OverviewTab
                  stats={stats}
                  incompleteCount={incompleteKeys.size}
                  health={health}
                  onGoTo={switchTab}
                />
              )}
              {tab === 'artists' && (
                <ArtistsTab
                  sort={artistSort}
                  onSortChange={setArtistSort}
                  artistHref={artistHref}
                />
              )}
              {tab === 'albums' && (
                <AlbumsTab
                  sort={albumSort}
                  onSortChange={setAlbumSort}
                  onSelect={setAlbumMeta}
                  albumHref={albumHref}
                  incomplete={incomplete}
                  incompleteKeys={incompleteKeys}
                />
              )}
              {tab === 'tracks' && (
                <TracksTab onPlay={(track, queue) => setPlaying({ track, queue })} />
              )}
              {tab === 'incomplete' && (
                <IncompleteTab albums={incomplete} onSelect={setAlbumMeta} albumHref={albumHref} />
              )}
              {tab === 'health' && (
                <HealthTab
                  health={health}
                  totalTracks={stats.totalTracks}
                  duplicateCount={health.duplicateCount}
                  onFixed={refresh}
                  onGoTo={switchTab}
                  onSelectAlbum={openAlbum}
                  onPlay={(track, queue) => setPlaying({ track, queue })}
                />
              )}
              {tab === 'duplicates' && (
                <DuplicatesTab onPlay={(track, queue) => setPlaying({ track, queue })} />
              )}
              {tab === 'changes' && <ChangesTab onUndone={refresh} />}
              {/* Opt-in: walks the rate-limited MusicBrainz queue. */}
              {tab === 'discover' && <DiscoveryPanel />}
            </>
          )}
        </>
      )}

      {playing && (
        <PlayerBar
          track={playing.track}
          queue={playing.queue}
          onChange={(track) => track && setPlaying({ track, queue: playing.queue })}
          onClose={() => setPlaying(null)}
        />
      )}
    </div>
  );
}
