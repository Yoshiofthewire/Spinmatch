import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TrashTab from './TrashTab.jsx';
import ScanStatus from './ScanStatus.jsx';
import { installFetchMock, jsonResponse } from '../../test/fetchMock.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const trashList = (entries) => ({
  test: (url) => url.startsWith('/api/library/trash?'),
  respond: () => jsonResponse({
    entries,
    total: entries.length,
    totals: { count: entries.length, bytes: entries.reduce((s, e) => s + e.size, 0) },
    limit: 100,
    offset: 0,
  }),
});

const entry = (relPath, restorable = true) => ({
  relPath, originalPath: relPath, size: 2 * 1024 * 1024, mtimeMs: 1_700_000_000_000, restorable,
});

describe('TrashTab', () => {
  it('shows the empty state', async () => {
    installFetchMock([trashList([])]);
    render(<TrashTab />);
    expect(await screen.findByText('Nothing has been moved aside.')).toBeInTheDocument();
  });

  it('lists entries with the total, restores one and shows a conflict inline', async () => {
    const calls = installFetchMock([
      trashList([entry('A/Al/a.flac'), entry('B/Bl/b.mp3', false)]),
      {
        method: 'POST',
        test: (url, body) => url === '/api/library/trash/restore' && body.relPath === 'A/Al/a.flac',
        respond: () => jsonResponse({ relPath: 'A/Al/a.flac', restoredPath: '/music/A/Al/a.flac' }),
      },
      // The refetch after the restore.
      trashList([entry('B/Bl/b.mp3', false)]),
      {
        method: 'POST',
        test: (url, body) => url === '/api/library/trash/restore' && body.relPath === 'B/Bl/b.mp3',
        respond: () => jsonResponse(
          { error: { code: 'CONFLICT', message: 'Something is already at that path, so the copy has been left in the trash.' } },
          { status: 409 },
        ),
      },
    ]);
    const onRestored = vi.fn();
    const user = userEvent.setup();
    render(<TrashTab onRestored={onRestored} />);

    expect(await screen.findByText('A/Al/a.flac')).toBeInTheDocument();
    expect(screen.getByText(/2 files \(4\.0 MB\) moved aside/)).toBeInTheDocument();
    expect(screen.getByText(/already at the original path/)).toBeInTheDocument();

    const [first, second] = screen.getAllByRole('button', { name: 'Restore' });
    await user.click(first);
    expect(await screen.findByText('Restored: A/Al/a.flac')).toBeInTheDocument();
    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/^1 file \(2\.0 MB\) moved aside/)).toBeInTheDocument();
    expect(screen.queryByText('A/Al/a.flac')).not.toBeInTheDocument();

    await user.click(second);
    expect(await screen.findByText(/so the copy has been left in the trash/)).toBeInTheDocument();
    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
      { relPath: 'A/Al/a.flac' }, { relPath: 'B/Bl/b.mp3' },
    ]);
  });


  it('keeps every remaining file reachable after a restore on page 1 of 2', async () => {
    let files = Array.from({ length: 101 }, (_, k) => entry(`F/${String(k).padStart(3, '0')}.flac`));
    let lastUrl = '';
    installFetchMock([
      {
        once: false,
        test: (url) => { lastUrl = url; return url.startsWith('/api/library/trash?'); },
        respond: () => {
          const offset = Number(new URL(lastUrl, 'http://x').searchParams.get('offset') ?? 0);
          return jsonResponse({
            entries: files.slice(offset, offset + 100),
            total: files.length,
            totals: { count: files.length, bytes: files.length * 2 * 1024 * 1024 },
          });
        },
      },
      {
        once: false,
        method: 'POST',
        test: (url, body) => {
          if (url !== '/api/library/trash/restore') return false;
          files = files.filter((f) => f.relPath !== body.relPath);
          return true;
        },
        respond: () => jsonResponse({}),
      },
    ]);
    const user = userEvent.setup();
    render(<TrashTab />);

    await screen.findByText('F/000.flac');
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    await user.click(screen.getAllByRole('button', { name: 'Restore' })[0]);

    // The refetch shows the 100 that remain on one page; nothing is stranded on page 2.
    expect(await screen.findByText('F/100.flac')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Restore' })).toHaveLength(100);
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
  });

  it('keeps each row busy until its own restore settles', async () => {
    const settle = {};
    installFetchMock([
      { once: false, ...trashList([entry('A/a.flac'), entry('B/b.flac')]) },
      ...['A/a.flac', 'B/b.flac'].map((rel) => ({
        method: 'POST',
        test: (url, body) => url === '/api/library/trash/restore' && body.relPath === rel,
        respond: () => new Promise((resolve) => { settle[rel] = () => resolve(jsonResponse({})); }),
      })),
    ]);
    const user = userEvent.setup();
    render(<TrashTab />);

    const [a, b] = await screen.findAllByRole('button', { name: 'Restore' });
    await user.click(a);
    await user.click(b);
    expect(screen.getAllByRole('button', { name: 'Restoring…' })).toHaveLength(2);

    await act(async () => { settle['A/a.flac'](); });
    // B is still in flight, so its button stays disabled.
    expect(screen.getByRole('button', { name: 'Restoring…' })).toBeDisabled();
  });
});

describe('ScanStatus', () => {
  const NOW = new Date('2026-10-11T12:00:00Z').getTime();

  function serveStatus(initial) {
    const state = { current: initial };
    const calls = installFetchMock([{
      once: false,
      test: (url) => url === '/api/library/scan/status',
      respond: () => jsonResponse(state.current),
    }]);
    return { state, calls };
  }

  // Runs due timers and settles the fetches they start.
  const advance = (ms) => act(() => vi.advanceTimersByTimeAsync(ms));

  it('shows last and next scan, the watcher and the last error when idle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    serveStatus({
      scanning: false, scanned: 0, lastScanAt: NOW - 5 * 60_000, nextScanAt: NOW + 25 * 60_000,
      watching: true, lastError: 'The last scan failed. The server log has the details.',
    });
    render(<ScanStatus />);
    await advance(0);

    expect(screen.getByText('Last scan 5 minutes ago · next scan in 25 minutes · watcher on')).toBeInTheDocument();
    expect(screen.getByText(/The last scan failed/)).toBeInTheDocument();
  });

  it('polls every 2 s while scanning, every 60 s when idle, and stops on unmount', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const idle = {
      scanning: false, scanned: 900, lastScanAt: NOW, nextScanAt: null, watching: false, lastError: null,
    };
    const { state, calls } = serveStatus({ ...idle, scanning: true, scanned: 250 });
    const { unmount } = render(<ScanStatus />);
    await advance(0);
    expect(screen.getByText('Scanning… 250 files')).toBeInTheDocument();

    const fast = calls.length;
    state.current = { ...idle, scanning: true, scanned: 500 };
    await advance(2000);
    expect(calls.length).toBe(fast + 1);
    expect(screen.getByText('Scanning… 500 files')).toBeInTheDocument();

    state.current = idle;
    await advance(2000);
    expect(screen.getByText('Last scan 4 seconds ago · watcher off')).toBeInTheDocument();

    const slow = calls.length;
    await advance(2000);
    expect(calls.length).toBe(slow); // no fast polling once idle
    await advance(58_000);
    expect(calls.length).toBe(slow + 1);

    unmount();
    await advance(180_000);
    expect(calls.length).toBe(slow + 1);
  });
});
