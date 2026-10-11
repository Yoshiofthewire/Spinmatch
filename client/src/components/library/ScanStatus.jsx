import { useEffect, useState } from 'react';
import { getScanStatus } from '../../api/library.js';
import { formatRelative } from '../../lib/format.js';

const FAST_POLL_MS = 2000;
const SLOW_POLL_MS = 60_000;

// `busy`: the page started a scan itself, so poll fast before the server reports it.
export default function ScanStatus({ busy = false }) {
  const [status, setStatus] = useState(null);
  const scanning = busy || Boolean(status?.scanning);

  // Re-runs on every scanning flip, which also fetches once right away.
  useEffect(() => {
    let cancelled = false;
    const poll = () => getScanStatus()
      .then((next) => { if (!cancelled) setStatus(next); })
      .catch(() => { /* keep the last status; the next poll retries */ });
    poll();
    const timer = setInterval(poll, scanning ? FAST_POLL_MS : SLOW_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [scanning]);

  if (!status) return null;
  if (scanning) {
    const files = status.scanning ? status.scanned : 0;
    return <span className="muted">Scanning… {files.toLocaleString()} files</span>;
  }

  const parts = [
    status.lastScanAt ? `Last scan ${formatRelative(status.lastScanAt)}` : 'Not scanned yet',
    status.nextScanAt && `next scan ${formatRelative(status.nextScanAt)}`,
    `watcher ${status.watching ? 'on' : 'off'}`,
  ].filter(Boolean);
  return (
    <>
      <span className="muted">{parts.join(' · ')}</span>
      {status.lastError && <span className="banner banner-error">{status.lastError}</span>}
    </>
  );
}
