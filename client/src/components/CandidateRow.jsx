import { formatDuration } from '../lib/format.js';

// One MusicBrainz recording to pick; shared by ingest review and library tag fix.
export default function CandidateRow({
  mbid, title, artist, releaseGroupTitle, lengthMs, score, busy, onUse,
}) {
  return (
    <li className="ingest-candidate-row">
      <span>
        {title} — {artist}
        {releaseGroupTitle ? ` (${releaseGroupTitle})` : ''} · {formatDuration(lengthMs)}
        {score != null && ` · score ${score.toFixed(2)}`}
      </span>
      <button type="button" onClick={() => onUse(mbid)} disabled={busy}>
        {busy ? 'Applying…' : 'Use this'}
      </button>
    </li>
  );
}
