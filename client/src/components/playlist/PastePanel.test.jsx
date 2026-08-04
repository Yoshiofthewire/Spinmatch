import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PastePanel from './PastePanel.jsx';
import { installFetchMock, jsonResponse } from '../../test/fetchMock.js';

afterEach(cleanup);

const RECONSTRUCTED = {
  found: [
    {
      line: 'Radiohead - Idioteque',
      track: { artist: 'Radiohead', title: 'Idioteque', album: 'Kid A', durationMs: 300_000 },
    },
  ],
  missing: [
    { line: 'Some Band - Nowhere Song', artist: 'Some Band', title: 'Nowhere Song' },
  ],
};

function reconstructRoute() {
  return {
    test: (url) => url === '/api/library/reconstruct-playlist',
    respond: () => jsonResponse(RECONSTRUCTED),
  };
}

function itemsRoute() {
  return {
    test: (url) => url === '/api/playlists/pl1/items',
    respond: () => jsonResponse({ added: 1 }),
  };
}

async function submitLines(user) {
  const textarea = screen.getByPlaceholderText(/Radiohead - Idioteque/);
  await user.type(textarea, 'Radiohead - Idioteque{enter}Some Band - Nowhere Song');
  await user.click(screen.getByRole('button', { name: /Match 2 lines/ }));
  await screen.findByText('Idioteque');
}

describe('PastePanel', () => {
  it('adds a found line as source: paste', async () => {
    installFetchMock([reconstructRoute()]);
    const user = userEvent.setup();
    render(<PastePanel playlistId="pl1" />);
    await submitLines(user);

    const calls = installFetchMock([itemsRoute()]);
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(calls).toHaveLength(1);
    expect(calls[0].body.items).toEqual([{
      artist: 'Radiohead', title: 'Idioteque', album: 'Kid A', source: 'paste',
    }]);
  });

  it('adds a missing line as source: paste, carrying the parsed artist/title', async () => {
    installFetchMock([reconstructRoute()]);
    const user = userEvent.setup();
    render(<PastePanel playlistId="pl1" />);
    await submitLines(user);

    await screen.findByText('Some Band - Nowhere Song');
    const calls = installFetchMock([itemsRoute()]);
    await user.click(screen.getByRole('button', { name: 'Add anyway' }));

    expect(calls).toHaveLength(1);
    expect(calls[0].body.items).toEqual([{
      artist: 'Some Band', title: 'Nowhere Song', album: null, source: 'paste',
    }]);
  });
});
