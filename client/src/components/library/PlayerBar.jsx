import { useEffect, useRef, useState } from 'react';
import { streamUrl } from '../../api/library.js';
import { formatDuration } from '../../lib/format.js';

// Preview player for checking a file matches its tags; the queue is the list on screen.
export default function PlayerBar({ track, queue, onChange, onClose }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [error, setError] = useState(null);

  const index = queue.findIndex((t) => t.id === track.id);
  const previous = index > 0 ? queue[index - 1] : null;
  const next = index >= 0 && index < queue.length - 1 ? queue[index + 1] : null;

  // AbortError only means a newer load() interrupted this play() — not a failure.
  function start(audio) {
    audio.play().then(() => setPlaying(true)).catch((err) => {
      setPlaying(false);
      if (err.name !== 'AbortError') setError(`Could not play this file: ${err.message}`);
    });
  }

  // New track: reset and autoplay (always follows an explicit click).
  useEffect(() => {
    setError(null);
    setPosition(0);
    const audio = audioRef.current;
    if (!audio) return;
    audio.load();
    start(audio);
  }, [track.id]);

  function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) { setError(null); start(audio); }
    else { audio.pause(); setPlaying(false); }
  }

  function seek(event) {
    const audio = audioRef.current;
    if (audio) audio.currentTime = Number(event.target.value);
    setPosition(Number(event.target.value));
  }

  // Decoded duration, else the indexed value while metadata loads.
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

      {error && <span className="player-error" role="alert">{error}</span>}
      <button type="button" onClick={onClose} aria-label="Close player">✕</button>
    </div>
  );
}
