import { useEffect, useState } from 'react';
import { checkOwned } from '../api/library.js';

// Which of the MusicBrainz results on screen are already in the local library,
// as a Set of ids to badge.
//
// Best-effort by design: the check is a nicety on top of search, so a failure
// (library not configured, request rejected) resolves to "badge nothing" rather
// than surfacing an error. Callers pass enabled=false when MUSIC_DIR isn't set,
// which skips the request entirely.
export function useOwned({ albums = [], recordings = [], enabled = true }) {
  const [owned, setOwned] = useState(() => new Set());

  // Serialized ids rather than the arrays themselves: the caller rebuilds those
  // on every render, which would re-fire this effect forever.
  const albumIds = albums.map((a) => a.id).join(',');
  const recordingIds = recordings.map((r) => r.id).join(',');

  useEffect(() => {
    if (!enabled || (!albums.length && !recordings.length)) {
      setOwned(new Set());
      return undefined;
    }
    let cancelled = false;
    checkOwned({ albums, recordings })
      .then((result) => {
        if (!cancelled) setOwned(new Set([...result.albums, ...result.recordings]));
      })
      .catch(() => {
        if (!cancelled) setOwned(new Set());
      });
    return () => { cancelled = true; };
  }, [albumIds, recordingIds, enabled]);

  return owned;
}
