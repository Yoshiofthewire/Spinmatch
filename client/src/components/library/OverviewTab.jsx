import { Link } from 'react-router-dom';
import { formatLongDuration, formatBytes } from '../../lib/format.js';
import { useServerList } from '../../lib/useServerList.js';
import { getHistory } from '../../api/history.js';
import ErrorBanner from '../ErrorBanner.jsx';
import { HistoryStatus, YouTubeLink } from '../HistoryEntry.jsx';

function Tile({ label, value, hint }) {
  return (
    <div className="stat-tile">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
      {hint && <span className="muted stat-hint">{hint}</span>}
    </div>
  );
}

function RecentVerifications() {
  const list = useServerList({ fetcher: getHistory, pageSize: 5 });
  return (
    <section className="recent-verifications">
      <h2>Recent verifications</h2>
      {list.state === 'error' && <ErrorBanner message={list.error} onRetry={list.reload} />}
      {list.data && (list.total === 0 ? <p className="muted">Nothing verified yet.</p> : (
        <ul>
          {list.data.entries.map((e) => (
            <li key={e.id}>
              {e.title}{e.artist && <span className="muted"> — {e.artist}</span>}{' '}
              {e.action === 'ingested' ? <span className="muted">Ingested</span> : <HistoryStatus status={e.status} />}{' '}
              <YouTubeLink videoId={e.videoId} />
            </li>
          ))}
        </ul>
      ))}
      <Link to="/history">All history</Link>
    </section>
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

      <RecentVerifications />
    </div>
  );
}
