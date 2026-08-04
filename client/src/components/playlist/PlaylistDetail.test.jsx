import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PlaylistDetail from './PlaylistDetail.jsx';
import { installFetchMock, errorResponse, jsonResponse, sseResponse } from '../../test/fetchMock.js';

// PlaylistDetail reads playlistExportEnabled from useConfig() to decide
// whether the "Export to player" button exists at all. Stubbing the hook
// directly (rather than rendering a real ConfigProvider, which would need its
// own GET /config route) keeps these tests about the Replace gate, not about
// how config loads.
vi.mock('../../ConfigContext.jsx', () => ({
  useConfig: () => ({ playlistExportEnabled: true }),
}));

const PLAYLIST = { id: 'pl1', name: 'Road Trip', items: [], lastExportedAt: null };

function playlistRoute() {
  return { test: (url) => url === '/api/playlists/pl1', respond: () => jsonResponse(PLAYLIST), once: false };
}

function dropoffRoute({ replace }, respond) {
  return {
    test: (url) => url.startsWith('/api/playlists/pl1/export/dropoff')
      && url.includes('replace=1') === replace,
    respond,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PlaylistDetail drop-off Replace gate', () => {
  it('surfaces the 409 file count and export date as a confirmation, not a failure', async () => {
    installFetchMock([
      playlistRoute(),
      dropoffRoute({ replace: false }, () => errorResponse({
        error: {
          code: 'DROPOFF_EXISTS',
          message: 'A folder already exists',
          existing: { dir: '/mnt/player/Road Trip', fileCount: 12, exportedAt: '2026-07-01T12:00:00.000Z' },
        },
      }, { status: 409 })),
    ]);

    const user = userEvent.setup();
    render(<PlaylistDetail id="pl1" />);
    await screen.findByText('Road Trip');

    await user.click(screen.getByRole('button', { name: 'Export to player' }));

    const banner = await screen.findByText(/A folder already exists/);
    expect(banner).toHaveClass('banner-rate-limited');
    expect(banner).not.toHaveClass('banner-error');
    expect(banner.textContent).toContain('12 files');
    expect(banner.textContent).toContain(new Date('2026-07-01T12:00:00.000Z').toLocaleString());
  });

  it('does not request replace=1 until Replace is clicked, and does so once clicked', async () => {
    const calls = installFetchMock([
      playlistRoute(),
      dropoffRoute({ replace: false }, () => errorResponse({
        error: {
          code: 'DROPOFF_EXISTS',
          message: 'A folder already exists',
          existing: { fileCount: 3, exportedAt: '2026-07-01T12:00:00.000Z' },
        },
      }, { status: 409 })),
      dropoffRoute({ replace: true }, () => sseResponse([
        { event: 'done', data: { dir: '/mnt/player/Road Trip', copied: 5, skipped: 0, bytes: 12345 } },
      ])),
      // No second playlistRoute() needed for the post-export reload: the
      // first one is `once: false` (playlistRoute's default), so it stays in
      // the queue and answers GET /playlists/pl1 again.
    ]);

    const user = userEvent.setup();
    render(<PlaylistDetail id="pl1" />);
    await screen.findByText('Road Trip');

    // Nothing has hit the network for the export at all yet.
    expect(calls.some((c) => c.url.includes('/export/dropoff'))).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Export to player' }));
    await screen.findByText(/A folder already exists/);

    // The pre-check happened, and it did NOT carry replace=1.
    const dropoffCalls = calls.filter((c) => c.url.includes('/export/dropoff'));
    expect(dropoffCalls).toHaveLength(1);
    expect(dropoffCalls[0].url).not.toContain('replace=1');

    await user.click(screen.getByRole('button', { name: 'Replace' }));

    await waitFor(() => {
      expect(calls.filter((c) => c.url.includes('/export/dropoff'))).toHaveLength(2);
    });
    const secondCall = calls.filter((c) => c.url.includes('/export/dropoff'))[1];
    expect(secondCall.url).toContain('replace=1');

    await screen.findByText(/Copied 5 files/);
  });

  it('never sends replace=1 when the confirmation is cancelled instead of confirmed', async () => {
    const calls = installFetchMock([
      playlistRoute(),
      dropoffRoute({ replace: false }, () => errorResponse({
        error: {
          code: 'DROPOFF_EXISTS',
          message: 'A folder already exists',
          existing: { fileCount: 1, exportedAt: '2026-07-01T12:00:00.000Z' },
        },
      }, { status: 409 })),
    ]);

    const user = userEvent.setup();
    render(<PlaylistDetail id="pl1" />);
    await screen.findByText('Road Trip');

    await user.click(screen.getByRole('button', { name: 'Export to player' }));
    await screen.findByText(/A folder already exists/);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    // No further request at all -- cancelling is purely local state.
    expect(calls.filter((c) => c.url.includes('/export/dropoff'))).toHaveLength(1);
    expect(calls.some((c) => c.url.includes('replace=1'))).toBe(false);
  });
});
