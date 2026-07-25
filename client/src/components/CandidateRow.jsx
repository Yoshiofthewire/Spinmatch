import { formatDuration } from '../lib/format.js';

// One MusicBrainz recording offered for a human to pick. Shared by the ingest
// needs-review picker and the library tag-fix panel: the two apply the choice
// differently (ingest tags and moves the file, the library only writes tags in
// place) but they offer the identical choice, so they render it identically.
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
