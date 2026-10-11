import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import PlaylistsPage from './PlaylistsPage.jsx';
import { installFetchMock, jsonResponse } from '../test/fetchMock.js';

afterEach(cleanup);

const M3U = '#EXTM3U\n#EXTINF:200,Portishead - Roads\nPortishead/Dummy/04.flac\n';

function listRoute() {
  return { test: (url) => url === '/api/playlists', method: 'GET', respond: () => jsonResponse({ playlists: [] }) };
}

describe('PlaylistsPage m3u import', () => {
  it('imports the file under its name, then opens the playlist with the result', async () => {
    const calls = installFetchMock([
      listRoute(),
      {
        method: 'POST',
        test: (url) => url === '/api/playlists/import',
        respond: () => jsonResponse({ playlist: { id: 7, name: 'Trip hop' }, added: 3, gaps: 1, truncated: false }),
      },
      {
        test: (url) => url === '/api/playlists/7',
        once: false,
        respond: () => jsonResponse({ id: 7, name: 'Trip hop', items: [], lastExportedAt: null }),
      },
    ]);
    const user = userEvent.setup();
    render(<MemoryRouter><PlaylistsPage /></MemoryRouter>);

    await user.upload(
      screen.getByLabelText('Import .m3u'),
      new File([M3U], 'Trip hop.m3u8', { type: 'audio/x-mpegurl' }),
    );
    const name = await screen.findByLabelText('Imported playlist name');
    expect(name).toHaveValue('Trip hop');
    await user.click(screen.getByRole('button', { name: 'Import' }));

    expect(await screen.findByText(/Imported 3 tracks, 1 not in your library/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST').body).toEqual({ name: 'Trip hop', text: M3U });
  });

  it('shows a refused import as an error and stays on the list', async () => {
    installFetchMock([
      listRoute(),
      {
        method: 'POST',
        test: (url) => url === '/api/playlists/import',
        respond: () => jsonResponse(
          { error: { code: 'DUPLICATE_NAME', message: 'A playlist with that name already exists' } },
          { status: 409 },
        ),
      },
    ]);
    const user = userEvent.setup();
    render(<MemoryRouter><PlaylistsPage /></MemoryRouter>);

    await user.upload(screen.getByLabelText('Import .m3u'), new File([M3U], 'Dupe.m3u'));
    await user.click(await screen.findByRole('button', { name: 'Import' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('A playlist with that name already exists');
    expect(screen.getByLabelText('Imported playlist name')).toHaveValue('Dupe');
  });
});
