import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AddToPlaylistButton from './AddToPlaylistButton.jsx';
import { installFetchMock, jsonResponse } from '../test/fetchMock.js';

afterEach(cleanup);

function listRoute(playlists) {
  return { test: (url) => url === '/api/playlists', respond: () => jsonResponse({ playlists }) };
}

describe('AddToPlaylistButton', () => {
  it('posts source: manual when adding to an existing playlist', async () => {
    const calls = installFetchMock([
      listRoute([{ id: 'p1', name: 'Chill' }]),
      {
        test: (url) => url === '/api/playlists/p1/items',
        respond: () => jsonResponse({ added: 1 }),
      },
    ]);
    const user = userEvent.setup();
    render(<AddToPlaylistButton artist="Boards of Canada" title="Roygbiv" album="Music Has the Right to Children" />);

    await user.click(screen.getByRole('button', { name: '+ Playlist' }));
    await user.click(await screen.findByRole('button', { name: 'Chill' }));

    await screen.findByText('Added');
    const post = calls.find((c) => c.url === '/api/playlists/p1/items');
    expect(post.body.items).toEqual([{
      artist: 'Boards of Canada', title: 'Roygbiv', album: 'Music Has the Right to Children', source: 'manual',
    }]);
  });

  it('is usable with no playlists yet: creating one adds to it in the same action', async () => {
    const calls = installFetchMock([
      listRoute([]),
      {
        test: (url) => url === '/api/playlists',
        method: 'POST',
        respond: () => jsonResponse({ id: 'new1', name: 'Fresh Start' }),
      },
      {
        test: (url) => url === '/api/playlists/new1/items',
        respond: () => jsonResponse({ added: 1 }),
      },
    ]);
    const user = userEvent.setup();
    render(<AddToPlaylistButton artist="Aphex Twin" title="Xtal" album={null} />);

    await user.click(screen.getByRole('button', { name: '+ Playlist' }));
    await screen.findByText('No playlists yet.');

    const nameInput = screen.getByLabelText('New playlist name');
    await user.type(nameInput, 'Fresh Start');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await screen.findByText('Added');
    const create = calls.find((c) => c.url === '/api/playlists' && c.method === 'POST');
    expect(create.body).toEqual({ name: 'Fresh Start' });
    const post = calls.find((c) => c.url === '/api/playlists/new1/items');
    expect(post.body.items[0]).toMatchObject({ artist: 'Aphex Twin', title: 'Xtal', source: 'manual' });
  });

  it('keeps state independent between two instances on two rows', async () => {
    installFetchMock([
      // Only the first row's menu is ever opened, so only one GET /playlists
      // is expected -- the second instance's `playlists === null` never
      // triggers a fetch.
      listRoute([{ id: 'p1', name: 'Chill' }]),
      {
        test: (url) => url === '/api/playlists/p1/items',
        respond: () => jsonResponse({ added: 1 }),
      },
    ]);
    const user = userEvent.setup();
    render(
      <>
        <AddToPlaylistButton artist="A" title="Row One" album={null} />
        <AddToPlaylistButton artist="B" title="Row Two" album={null} />
      </>,
    );

    const [firstToggle, secondToggle] = screen.getAllByRole('button', { name: '+ Playlist' });
    await user.click(firstToggle);
    await user.click(await screen.findByRole('button', { name: 'Chill' }));
    await screen.findByText('Added');

    // The second row's menu was never opened, so it has nothing to show --
    // no "Added", no playlist list -- proving the two instances don't share
    // `open`/`addedId` state.
    expect(secondToggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByText('Added')).toHaveLength(1);
  });
});
