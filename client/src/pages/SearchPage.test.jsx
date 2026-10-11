import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import SearchPage from './SearchPage.jsx';
import { installFetchMock, jsonResponse } from '../test/fetchMock.js';

afterEach(cleanup);

function Probe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="search">{location.search}</output>
      <button type="button" onClick={() => navigate(-1)}>Go back</button>
    </>
  );
}

describe('SearchPage', () => {
  it('writes ?q= to the URL, fetches once per query, and Back restores the previous search', async () => {
    const calls = installFetchMock([{
      once: false,
      test: (url) => url.startsWith('/api/search?'),
      respond: () => jsonResponse({ artists: [], releaseGroups: [], recordings: [] }),
    }]);
    const searches = () => calls.map((c) => new URL(c.url, 'http://x').searchParams.get('q'));
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/?q=first']}>
        <Routes>
          <Route path="/" element={<><SearchPage /><Probe /></>} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(searches()).toEqual(['first']));
    expect(document.title).toBe('Search · Spinmatch');

    const input = screen.getByRole('textbox', { name: 'Search' });
    await user.clear(input);
    await user.type(input, 'second{Enter}');

    expect(screen.getByTestId('search')).toHaveTextContent('?q=second');
    await waitFor(() => expect(searches()).toEqual(['first', 'second']));

    await user.click(screen.getByRole('button', { name: 'Go back' }));
    expect(screen.getByTestId('search')).toHaveTextContent('?q=first');
    expect(input).toHaveValue('first');
    await waitFor(() => expect(searches()).toEqual(['first', 'second', 'first']));
  });
});
