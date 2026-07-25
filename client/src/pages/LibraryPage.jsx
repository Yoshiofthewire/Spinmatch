import { useEffect, useMemo, useState } from 'react';
import EqualizerLoader from '../components/EqualizerLoader.jsx';
import Breadcrumbs from '../components/Breadcrumbs.jsx';
import OverviewTab from '../components/library/OverviewTab.jsx';
import ArtistsTab from '../components/library/ArtistsTab.jsx';
import AlbumsTab from '../components/library/AlbumsTab.jsx';
import TracksTab from '../components/library/TracksTab.jsx';
import IncompleteTab from '../components/library/IncompleteTab.jsx';
import HealthTab from '../components/library/HealthTab.jsx';
import DuplicatesTab from '../components/library/DuplicatesTab.jsx';
import DiscoveryPanel from '../components/library/DiscoveryPanel.jsx';
import PlaylistPanel from '../components/library/PlaylistPanel.jsx';
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
  ['discover', 'Discover'],
];

export default function LibraryPage() {
  const [tab, setTab] = useState('overview');
  // Drill-down state, kept here rather than in the router: artist and album
  // names routinely contain slashes, which path params handle badly.
  const [selectedArtist, setSelectedArtist] = useState(null);
  const [selectedAlbum, setSelectedAlbum] = useState(null);

  const [stats, setStats] = useState(null);
  const [incomplete, setIncomplete] = useState([]);
  const [health, setHealth] = useState(null);

  const [artistSort, setArtistSort] = useState('name');
  const [albumSort, setAlbumSort] = useState('artist');

  const [state, setState] = useState('loading'); // loading | ready | error
  const [error, setError] = useState(null);
  const [scanning, setScanning] = useState(false);

  const [playing, setPlaying] = useState(null); // {track, queue}

  // showLoading=false is for refreshes triggered by an action inside a tab (a tag
  // fix, a targeted rescan). Flipping to the global loading state would unmount
  // the tab and throw away where the user was — the open drill-down, the album
  // they were looking at — which is jarring for what is just a counter update.
  async function load({ showLoading = true } = {}) {
    if (showLoading) setState('loading');
    setError(null);
    try {
      // Only what the page frame itself needs. Every tab that shows a list —
      // artists, albums, tracks — fetches its own page from the server, so
      // opening the Library no longer pulls the whole collection down first.
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

  function openArtist(artist) {
    setSelectedAlbum(null);
    setSelectedArtist(artist);
  }

  function openAlbum(album) {
    setSelectedAlbum(album);
  }

  function clearSelection() {
    setSelectedArtist(null);
    setSelectedAlbum(null);
  }

  function switchTab(next) {
    clearSelection();
    setTab(next);
  }

  const crumbs = [{ label: 'Library', to: null }];
  if (selectedArtist) crumbs.push({ label: selectedArtist, to: null });
  if (selectedAlbum) crumbs.push({ label: selectedAlbum.album, to: null });

  return (
    <div className={`library-page${playing ? ' library-page-playing' : ''}`}>
      <h1>Your Library</h1>

      {error && <p className="banner banner-error">{error}</p>}
      {state === 'loading' && <EqualizerLoader label="Loading your library…" />}

      {state === 'ready' && (
        <>
          <div className="library-header">
            <nav className="library-tabs">
              {TABS.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`library-tab${tab === key && !selectedArtist ? ' library-tab-active' : ''}`}
                  onClick={() => switchTab(key)}
                >
                  {label}
                </button>
              ))}
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
            />
          ) : selectedArtist ? (
            <ArtistDetail
              artist={selectedArtist}
              onSelectAlbum={openAlbum}
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
                  onSelect={openArtist}
                />
              )}
              {tab === 'albums' && (
                <AlbumsTab
                  sort={albumSort}
                  onSortChange={setAlbumSort}
                  onSelect={openAlbum}
                  incomplete={incomplete}
                  incompleteKeys={incompleteKeys}
                />
              )}
              {tab === 'tracks' && (
                <TracksTab onPlay={(track, queue) => setPlaying({ track, queue })} />
              )}
              {tab === 'incomplete' && (
                <IncompleteTab albums={incomplete} onSelect={openAlbum} />
              )}
              {tab === 'health' && (
                <HealthTab
                  health={health}
                  totalTracks={stats.totalTracks}
                  duplicateCount={health.duplicateCount}
                  onFixed={refresh}
                  onGoTo={switchTab}
                  onSelectAlbum={openAlbum}
                />
              )}
              {tab === 'duplicates' && (
                <DuplicatesTab onPlay={(track, queue) => setPlaying({ track, queue })} />
              )}
              {/* The one tab that looks outward. Both panels are opt-in: the
                  discovery half walks the rate-limited MusicBrainz queue, and
                  the playlist half needs input before it has anything to do. */}
              {tab === 'discover' && (
                <>
                  <DiscoveryPanel />
                  <PlaylistPanel onPlay={(track, queue) => setPlaying({ track, queue })} />
                </>
              )}
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
