import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import IngestPanel from './IngestPanel.jsx';
import { installFetchMock, jsonResponse } from '../test/fetchMock.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const items = [{ path: '/in/a.flac', name: 'a.flac' }, { path: '/in/b.flac', name: 'b.flac' }];

describe('IngestPanel', () => {
  // jsdom has no EventSource, so a confirmed run takes the blocking POST path.
  it('requires an inline confirm before processing', async () => {
    const calls = installFetchMock([
      { test: (url) => url === '/api/ingest/scan', respond: () => jsonResponse({ items }) },
      {
        method: 'POST',
        test: (url) => url === '/api/ingest/process',
        respond: () => jsonResponse({ matched: [], needsReview: [], dryRun: false }),
      },
    ]);
    const user = userEvent.setup();
    render(<IngestPanel />);

    await user.click(screen.getByRole('button', { name: 'Scan ingest folder' }));
    await user.click(await screen.findByRole('button', { name: 'Process 2 items' }));

    expect(screen.getByText('Write tags and move 2 files?')).toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/ingest/process')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls.some((c) => c.url === '/api/ingest/process')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Process 2 items' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await screen.findByText('Matched & tagged (0)');
    const run = calls.find((c) => c.url === '/api/ingest/process');
    expect(run.body).toEqual({ dryRun: false });
  });
});
