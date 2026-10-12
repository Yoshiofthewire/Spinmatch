import { useEffect, useState } from 'react';
import { checkOwned } from '../api/library.js';

// Set of on-screen MusicBrainz ids already owned. Failure badges nothing, never blocks.
export function useOwned({ albums = [], recordings = [], enabled = true }) {
  const [owned, setOwned] = useState(() => new Set());
  const [error, setError] = useState(null);

  // Serialized: callers rebuild the arrays every render.
  const albumIds = albums.map((a) => a.id).join(',');
  const recordingIds = recordings.map((r) => r.id).join(',');

  useEffect(() => {
    setError(null);
    if (!enabled || (!albums.length && !recordings.length)) {
      setOwned(new Set());
      return undefined;
    }
    let cancelled = false;
    checkOwned({ albums, recordings })
      .then((result) => {
        if (!cancelled) setOwned(new Set([...result.albums, ...result.recordings]));
      })
      .catch((err) => {
        if (cancelled) return;
        setOwned(new Set());
        setError(err.message);
      });
    return () => { cancelled = true; };
  }, [albumIds, recordingIds, enabled]);

  return { owned, error };
}
