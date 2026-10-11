import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import HistoryPage from './HistoryPage.jsx';
import { installFetchMock, jsonResponse } from '../test/fetchMock.js';

afterEach(cleanup);

const isList = (url) => url.startsWith('/api/history?');
const ENTRIES = [
  { id: 2, title: 'Roygbiv', artist: 'Boards of Canada', action: 'verified', status: 'confirmed', videoId: 'a&b=c', createdAt: 2000 },
  { id: 1, title: 'Aquarius', artist: 'Boards of Canada', action: 'ingested', status: null, videoId: null, createdAt: 1000 },
];

describe('HistoryPage', () => {
  it('renders server entries with their status and an encoded YouTube link', async () => {
    const calls = installFetchMock([
      { test: isList, respond: () => jsonResponse({ entries: ENTRIES, total: 2 }) },
    ]);
    render(<HistoryPage />);

    const row = (await screen.findByText('Roygbiv')).closest('tr');
    expect(within(row).getByText('Confirmed')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'YouTube' }))
      .toHaveAttribute('href', 'https://www.youtube.com/watch?v=a%26b%3Dc');
    const ingested = screen.getByText('Aquarius').closest('tr');
    expect(within(ingested).getByText('Ingested')).toBeInTheDocument();
    expect(within(ingested).queryByRole('link')).not.toBeInTheDocument();
    expect(calls[0].url).toBe('/api/history?limit=50&offset=0');
  });

  it('only clears history after an inline confirm, then refetches', async () => {
    const calls = installFetchMock([
      { test: isList, respond: () => jsonResponse({ entries: ENTRIES, total: 2 }) },
      { method: 'DELETE', test: (url) => url === '/api/history', respond: () => jsonResponse({ cleared: 2 }) },
      { test: isList, respond: () => jsonResponse({ entries: [], total: 0 }) },
    ]);
    const user = userEvent.setup();
    render(<HistoryPage />);

    await user.click(await screen.findByRole('button', { name: 'Clear All' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(screen.getByText('Roygbiv')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear All' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('No history yet.')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('shows the error when Clear All fails and keeps the entries', async () => {
    installFetchMock([
      { test: isList, respond: () => jsonResponse({ entries: ENTRIES, total: 2 }) },
      { method: 'DELETE', test: () => true, respond: () => jsonResponse({ error: { message: 'nope' } }, { status: 500 }) },
    ]);
    const user = userEvent.setup();
    render(<HistoryPage />);

    await user.click(await screen.findByRole('button', { name: 'Clear All' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('nope');
    expect(screen.getByText('Roygbiv')).toBeInTheDocument();
  });
});
