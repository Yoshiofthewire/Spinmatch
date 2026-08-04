import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SuggestPanel from './SuggestPanel.jsx';
import { installFetchMock, jsonResponse } from '../../test/fetchMock.js';

afterEach(cleanup);

function seedRoute(artist) {
  return {
    test: (url) => url.startsWith('/api/library/artists'),
    respond: () => jsonResponse({ artists: [{ artist, trackCount: 40 }] }),
  };
}

function suggestRoute(result) {
  return {
    test: (url) => url === '/api/playlists/pl1/suggest',
    respond: () => jsonResponse(result),
  };
}

function itemsRoute() {
  return {
    test: (url) => url === '/api/playlists/pl1/items',
    respond: () => jsonResponse({ added: 1 }),
  };
}

// Types a seed artist, waits for the debounced match, and clicks it. Every
// scenario below needs at least one seed before "Suggest tracks" is enabled.
async function addSeed(user, artist) {
  const input = screen.getByLabelText('Search your library for a seed artist');
  await user.type(input, artist.slice(0, 4));
  const pick = await screen.findByRole('button', { name: `+ ${artist}` });
  await user.click(pick);
}

const TWO_PICKS = {
  picked: [
    {
      matchKey: 'k1', artist: 'Aphex Twin', title: 'Xtal', album: 'SAW 85-92',
      durationMs: 240_000, sizeBytes: 6_000_000, seedArtist: 'Boards of Canada',
    },
    {
      matchKey: 'k2', artist: 'Boards of Canada', title: 'Roygbiv', album: 'Music Has the Right to Children',
      durationMs: 140_000, sizeBytes: 4_000_000, seedArtist: 'Boards of Canada',
    },
  ],
  stopped: 'target',
  cap: 10,
};

describe('SuggestPanel review step', () => {
  it('arrives with every proposal ticked, and posts only the ticked rows', async () => {
    installFetchMock([
      seedRoute('Boards of Canada'),
      suggestRoute(TWO_PICKS),
      itemsRoute(),
    ]);
    const user = userEvent.setup();
    render(<SuggestPanel playlistId="pl1" />);

    await addSeed(user, 'Boards of Canada');
    await user.click(screen.getByRole('button', { name: 'Suggest tracks' }));

    await screen.findByText('Xtal');
    expect(screen.getByLabelText('Include Xtal')).toBeChecked();
    expect(screen.getByLabelText('Include Roygbiv')).toBeChecked();

    await user.click(screen.getByLabelText('Include Roygbiv')); // untick row 2

    const calls = installFetchMock([itemsRoute()]); // fresh call log for the POST we care about
    await user.click(screen.getByRole('button', { name: /Add selected/ }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body.items).toHaveLength(1);
    expect(calls[0].body.items[0].title).toBe('Xtal');
  });

  it('posts the source that produced the rows, not the radio flipped after the fact', async () => {
    installFetchMock([seedRoute('Boards of Canada'), suggestRoute(TWO_PICKS)]);
    const user = userEvent.setup();
    render(<SuggestPanel playlistId="pl1" />);

    await addSeed(user, 'Boards of Canada');
    // method defaults to 'popular' -- submit while it's still Popular.
    await user.click(screen.getByRole('button', { name: 'Suggest tracks' }));
    await screen.findByText('Xtal');

    // Flip the live radio to Chance *after* results are showing, without
    // resubmitting. This is exactly the scenario submittedMethod exists to
    // guard against.
    await user.click(screen.getByRole('radio', { name: 'Chance' }));

    const calls = installFetchMock([itemsRoute()]);
    await user.click(screen.getByRole('button', { name: /Add selected/ }));

    await waitFor(() => expect(calls).toHaveLength(1));
    for (const item of calls[0].body.items) {
      expect(item.source).toBe('popular');
    }
  });

  it('shows popularity: unavailable as a note, not an error', async () => {
    installFetchMock([
      seedRoute('Boards of Canada'),
      suggestRoute({ ...TWO_PICKS, popularity: 'unavailable' }),
    ]);
    const user = userEvent.setup();
    render(<SuggestPanel playlistId="pl1" />);

    await addSeed(user, 'Boards of Canada');
    await user.click(screen.getByRole('button', { name: 'Suggest tracks' }));

    const note = await screen.findByText(/ListenBrainz popularity is unavailable/);
    expect(note).toHaveClass('banner-note');
    expect(note).not.toHaveClass('banner-error');
  });

  it('renders nothing for popularity: unused', async () => {
    installFetchMock([
      seedRoute('Boards of Canada'),
      suggestRoute({ ...TWO_PICKS, popularity: 'unused' }),
    ]);
    const user = userEvent.setup();
    render(<SuggestPanel playlistId="pl1" />);

    await addSeed(user, 'Boards of Canada');
    await user.click(screen.getByRole('button', { name: 'Suggest tracks' }));

    await screen.findByText('Xtal'); // results are in
    expect(screen.queryByText(/ListenBrainz/)).not.toBeInTheDocument();
  });

  it.each([
    ['cap', 'the per-artist cap held the rest back'],
    ['budget', 'the size limit stopped it there'],
    ['exhausted', "you don't own enough by these artists"],
    ['target', 'the target was reached'],
  ])('explains a %s stop distinctly', async (stopped, expectedPhrase) => {
    installFetchMock([seedRoute('Boards of Canada'), suggestRoute({ ...TWO_PICKS, stopped })]);
    const user = userEvent.setup();
    render(<SuggestPanel playlistId="pl1" />);

    await addSeed(user, 'Boards of Canada');
    await user.click(screen.getByRole('button', { name: 'Suggest tracks' }));

    await screen.findByText(new RegExp(expectedPhrase));
  });
});
