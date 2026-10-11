import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OverviewTab from './OverviewTab.jsx';
import { installFetchMock, jsonResponse } from '../../test/fetchMock.js';

afterEach(cleanup);

const stats = { totalTracks: 1, totalAlbums: 1, totalArtists: 1, totalDurationMs: 1000, totalBytes: 1, formats: [] };

describe('OverviewTab', () => {
  it('shows the five most recent verifications and links to History', async () => {
    const calls = installFetchMock([{
      test: (url) => url.startsWith('/api/history?'),
      respond: () => jsonResponse({
        entries: [{ id: 9, title: 'Dayvan Cowboy', artist: 'Boards of Canada', action: 'verified', status: 'unverified', videoId: 'xyz', createdAt: 1 }],
        total: 1,
      }),
    }]);
    render(
      <MemoryRouter>
        <OverviewTab stats={stats} incompleteCount={0} health={null} onGoTo={() => {}} />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Dayvan Cowboy')).toBeInTheDocument();
    expect(screen.getByText('Unverified')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'YouTube' })).toHaveAttribute('href', 'https://www.youtube.com/watch?v=xyz');
    expect(screen.getByRole('link', { name: 'All history' })).toHaveAttribute('href', '/history');
    expect(calls[0].url).toBe('/api/history?limit=5&offset=0');
  });
});
