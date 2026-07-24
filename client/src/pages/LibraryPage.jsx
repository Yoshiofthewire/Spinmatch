import { useEffect, useState } from 'react';
import { getLibraryStats, getLibraryArtists, scanLibrary } from '../api/library.js';

export default function LibraryPage() {
  const [stats, setStats] = useState(null);
  const [artists, setArtists] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState(null);

  async function load() {
    try {
      const [s, a] = await Promise.all([getLibraryStats(), getLibraryArtists()]);
      setStats(s);
      setArtists(a.artists);
    } catch (err) {
      setError(err.message);
    }
  }

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

  return (
    <div className="library-page">
      <h1>Your Library</h1>
      {error && <p className="banner banner-error">{error}</p>}
      {stats && (
        <div className="stats-row">
          <span>{stats.totalTracks} tracks</span>
          <span>{stats.totalAlbums} albums</span>
          <span>{stats.totalArtists} artists</span>
          {stats.lastScanAt > 0 && <span>last scan {new Date(stats.lastScanAt).toLocaleString()}</span>}
        </div>
      )}
      <button onClick={rescan} disabled={scanning}>{scanning ? 'Scanning…' : 'Rescan library'}</button>
      <ul className="artist-list">
        {artists.map((a) => <li key={a.artist}>{a.artist} ({a.trackCount})</li>)}
      </ul>
    </div>
  );
}
