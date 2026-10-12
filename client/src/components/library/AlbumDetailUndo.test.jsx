import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import AlbumDetail from './AlbumDetail.jsx';
import { installFetchMock, jsonResponse } from '../../test/fetchMock.js';

afterEach(cleanup);

const track = { id: 1, title: 'Idioteque', artist: 'Radiohead', album: 'Kid A', trackNumber: 8, disc: 1, durationMs: 300000, format: 'flac' };

describe('AlbumDetail album edit', () => {
  it('keeps the result and its Undo after the save reloads the tracklist', async () => {
    // The reload after a save is held open, as a real network would, so its
    // loading state actually renders.
    let release;
    const slowReload = new Promise((resolve) => { release = resolve; });
    const calls = installFetchMock([
      { test: (url) => url.startsWith('/api/library/album-tracks'), respond: () => jsonResponse({ tracks: [track] }) },
      {
        test: (url) => url.startsWith('/api/library/album-tracks'),
        respond: () => slowReload.then(() => jsonResponse({ tracks: [track] })),
      },
      {
        method: 'POST',
        test: (url) => url === '/api/library/album/tags',
        respond: () => jsonResponse({ applied: [{ trackId: 1, changedFields: ['year'] }], failed: [], skipped: 0, renamed: null, batchId: 9 }),
      },
    ]);
    const user = userEvent.setup();
    render(<MemoryRouter><AlbumDetail album={{ artist: 'Radiohead', album: 'Kid A' }} /></MemoryRouter>);

    await user.click(await screen.findByRole('button', { name: 'Edit album tags' }));
    await user.type(screen.getByLabelText('Year'), '2000');
    await user.click(screen.getByRole('button', { name: /^Review changes/ }));
    await user.click(screen.getByRole('button', { name: 'Write these tags' }));

    await screen.findByText('Loading tracklist…');
    release();
    await waitFor(() => expect(screen.queryByText('Loading tracklist…')).not.toBeInTheDocument());
    expect(calls.filter((c) => c.url.startsWith('/api/library/album-tracks'))).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });
});

describe('AlbumTagEditPanel', () => {
  it('renders a track that a rescan found while the editor was open, unticked', async () => {
    const { default: AlbumTagEditPanel } = await import('./AlbumTagEditPanel.jsx');
    const second = { ...track, id: 2, title: 'Morning Bell', trackNumber: 10 };
    const props = { artist: 'Radiohead', album: 'Kid A', onSaved: () => {}, onCancel: () => {} };
    const { rerender } = render(<AlbumTagEditPanel {...props} tracks={[track]} />);
    rerender(<AlbumTagEditPanel {...props} tracks={[track, second]} />);

    expect(screen.getByLabelText('Title for Morning Bell')).toHaveValue('Morning Bell');
    expect(screen.getByLabelText('Include Morning Bell')).not.toBeChecked();
    expect(screen.getByLabelText('Include Idioteque')).toBeChecked();
  });
});
