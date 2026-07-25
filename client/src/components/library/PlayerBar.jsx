import { useEffect, useRef, useState } from 'react';
import { streamUrl } from '../../api/library.js';
import { formatDuration } from '../../lib/format.js';

// A preview player, deliberately not a music player: it exists so you can
// confirm a file is what its tags claim before acting on it. No persistent
// queue, no transcoding, no cross-page playback — the queue is just whatever
// list was on screen when you pressed play.
export default function PlayerBar({ track, queue, onChange, onClose }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [error, setError] = useState(null);

  const index = queue.findIndex((t) => t.id === track.id);
  const previous = index > 0 ? queue[index - 1] : null;
  const next = index >= 0 && index < queue.length - 1 ? queue[index + 1] : null;

  // A new track means a new source: reset the transport and autoplay, since
  // reaching here is always the result of an explicit click.
  useEffect(() => {
    setError(null);
    setPosition(0);
    const audio = audioRef.current;
    if (!audio) return;
    audio.load();
    audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  }, [track.id]);

  function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    else { audio.pause(); setPlaying(false); }
  }

  function seek(event) {
    const audio = audioRef.current;
    if (audio) audio.currentTime = Number(event.target.value);
    setPosition(Number(event.target.value));
  }

  // Prefer the browser's decoded duration; fall back to the indexed tag value
  // while metadata is still loading.
  const duration = audioRef.current?.duration;
  const totalSeconds = Number.isFinite(duration) && duration > 0
    ? duration
    : (track.durationMs ?? 0) / 1000;

  return (
    <div className="player-bar">
      <audio
        ref={audioRef}
        src={streamUrl(track.id)}
        onTimeUpdate={(e) => setPosition(e.target.currentTime)}
        onEnded={() => (next ? onChange(next) : setPlaying(false))}
        onError={() => { setError('Could not play this file'); setPlaying(false); }}
        preload="metadata"
      />
      <button type="button" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? '❚❚' : '▶'}
      </button>
      <button type="button" onClick={() => onChange(previous)} disabled={!previous} aria-label="Previous track">
        ‹
      </button>
      <button type="button" onClick={() => onChange(next)} disabled={!next} aria-label="Next track">
        ›
      </button>

      <div className="player-meta">
        <span className="player-title">{track.title}</span>
        <span className="muted">{track.artist}{track.album ? ` — ${track.album}` : ''}</span>
      </div>

      <input
        className="player-seek"
        type="range"
        min="0"
        max={Math.max(totalSeconds, 0.1)}
        step="0.5"
        value={Math.min(position, totalSeconds || 0)}
        onChange={seek}
        aria-label="Seek"
      />
      <span className="mono player-time">
        {formatDuration(position * 1000)} / {formatDuration(totalSeconds * 1000)}
      </span>

      {error && <span className="player-error">{error}</span>}
      <button type="button" onClick={onClose} aria-label="Close player">✕</button>
    </div>
  );
}
