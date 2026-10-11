import { useState } from 'react';
import ErrorBanner from '../ErrorBanner.jsx';
import { importPlaylist } from '../../api/playlists.js';

// Reads the file in the browser; the server matches entries and creates the playlist.
export default function ImportM3uForm({ onImported }) {
  const [text, setText] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function pick(e) {
    const file = e.target.files?.[0];
    setError(null);
    setText(null);
    if (!file) return;
    try {
      setText(await file.text());
      setName(file.name.replace(/\.[^.]+$/, ''));
    } catch {
      setError('Could not read that file.');
    }
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onImported(await importPlaylist(name.trim(), text));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="playlist-create-form" onSubmit={submit}>
      <label>
        Import .m3u
        {' '}
        <input type="file" accept=".m3u,.m3u8,audio/x-mpegurl" onChange={pick} />
      </label>
      {text !== null && (
        <>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Imported playlist name"
          />
          <button type="submit" disabled={!name.trim() || busy}>
            {busy ? 'Importing…' : 'Import'}
          </button>
        </>
      )}
      {error && <ErrorBanner message={error} />}
    </form>
  );
}
