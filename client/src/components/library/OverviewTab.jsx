import { formatLongDuration, formatBytes } from '../../lib/format.js';

function Tile({ label, value, hint }) {
  return (
    <div className="stat-tile">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
      {hint && <span className="muted stat-hint">{hint}</span>}
    </div>
  );
}

export default function OverviewTab({ stats, incompleteCount, health, onGoTo }) {
  const topFormats = (stats.formats ?? []).slice(0, 4);

  return (
    <div className="library-overview">
      <div className="stat-tiles">
        <Tile label="tracks" value={stats.totalTracks.toLocaleString()} />
        <Tile label="albums" value={stats.totalAlbums.toLocaleString()} />
        <Tile label="artists" value={stats.totalArtists.toLocaleString()} />
        <Tile label="playtime" value={formatLongDuration(stats.totalDurationMs)} />
        <Tile label="on disk" value={formatBytes(stats.totalBytes)} />
      </div>

      {topFormats.length > 0 && (
        <p className="format-breakdown">
          {topFormats.map((f) => (
            <span key={f.ext} className="format-chip">
              <strong>{f.ext}</strong> {f.count.toLocaleString()}
            </span>
          ))}
        </p>
      )}

      <div className="overview-actions">
        {incompleteCount > 0 && (
          <button type="button" className="chip-button" onClick={() => onGoTo('incomplete')}>
            {incompleteCount.toLocaleString()}
            {incompleteCount === 1 ? ' album looks' : ' albums look'} incomplete
          </button>
        )}
        {health && health.missingTrackNumber > 0 && (
          <button type="button" className="chip-button" onClick={() => onGoTo('health')}>
            {health.missingTrackNumber.toLocaleString()}
            {health.missingTrackNumber === 1 ? ' track' : ' tracks'} missing a track number
          </button>
        )}
        {health && health.duplicateCount > 0 && (
          <button type="button" className="chip-button" onClick={() => onGoTo('duplicates')}>
            {health.duplicateCount.toLocaleString()} possible duplicate{health.duplicateCount === 1 ? '' : 's'}
          </button>
        )}
      </div>
    </div>
  );
}
