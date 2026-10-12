import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import App from './App.jsx';
import { ConfigProvider } from './ConfigContext.jsx';
import { installFetchMock, jsonResponse } from './test/fetchMock.js';

vi.mock('./AuthContext.jsx', () => ({ useAuth: () => ({ username: 'me', logout: () => {} }) }));

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  localStorage.clear();
  // Each page sets the title; don't let one test's title stand in for the next.
  document.title = '';
});

const isConfig = (url) => url === '/api/config';

function renderAt(path) {
  return render(
    <ConfigProvider>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </ConfigProvider>,
  );
}

describe('App', () => {
  it('shows an error banner when /config fails, and Retry refetches it', async () => {
    const calls = installFetchMock([
      { test: isConfig, respond: () => jsonResponse({ error: { message: 'boom' } }, { status: 500 }) },
      { test: isConfig, respond: () => jsonResponse({ libraryEnabled: true }) },
    ]);
    const user = userEvent.setup();
    renderAt('/about');

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load settings: boom");
    expect(screen.queryByRole('link', { name: 'Library' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('link', { name: 'Library' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(calls.filter((c) => isConfig(c.url))).toHaveLength(2);
  });

  it('imports legacy browser history once and removes it only after the server has it', async () => {
    const legacy = [{ track: 'Roygbiv', artist: 'Boards of Canada', action: 'verified', timestamp: 1000 }];
    localStorage.setItem('spinmatch:history', JSON.stringify(legacy));
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    const isImport = (url) => url === '/api/history/import';
    const calls = installFetchMock([
      { test: isConfig, respond: () => jsonResponse({}), once: false },
      { method: 'POST', test: isImport, respond: () => jsonResponse({ error: { message: 'down' } }, { status: 500 }) },
      { method: 'POST', test: isImport, respond: () => jsonResponse({ imported: 1, skipped: 0 }) },
    ]);

    // Failure: the browser copy is kept for the next load.
    const first = renderAt('/about');
    await vi.waitFor(() => expect(calls.filter((c) => isImport(c.url))).toHaveLength(1));
    await screen.findByRole('heading', { name: /about/i });
    expect(localStorage.getItem('spinmatch:history')).not.toBeNull();
    first.unmount();

    renderAt('/about');
    await vi.waitFor(() => expect(localStorage.getItem('spinmatch:history')).toBeNull());
    const imports = calls.filter((c) => isImport(c.url));
    expect(imports).toHaveLength(2);
    expect(imports[1].body).toEqual({ entries: legacy });
    cleanup();

    // Nothing left to import: a later load posts nothing.
    renderAt('/about');
    await screen.findByRole('heading', { name: /about/i });
    expect(calls.filter((c) => isImport(c.url))).toHaveLength(2);
    // Removed once, after the success; the failed attempt left it alone.
    expect(removeItem).toHaveBeenCalledTimes(1);
    removeItem.mockRestore();
  });

  it('still shows server history when browser storage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    installFetchMock([
      { test: isConfig, respond: () => jsonResponse({}), once: false },
      {
        test: (url) => url.startsWith('/api/history?'),
        respond: () => jsonResponse({ entries: [{ id: 1, title: 'From the server', artist: 'A', action: 'verified', status: 'confirmed', videoId: null, createdAt: 1 }], total: 1 }),
      },
    ]);
    renderAt('/history');
    expect(await screen.findByText('From the server')).toBeInTheDocument();
  });

  it('splits an oversized browser history into imports under the body limit', async () => {
    const long = 'x'.repeat(480);
    const legacy = Array.from({ length: 200 }, (_, i) => ({ track: `${long}${i}`, artist: long, album: long, action: 'verified', timestamp: 1000 + i }));
    localStorage.setItem('spinmatch:history', JSON.stringify(legacy));
    const calls = installFetchMock([
      { test: isConfig, respond: () => jsonResponse({}), once: false },
      { once: false, method: 'POST', test: (url) => url === '/api/history/import', respond: () => jsonResponse({ imported: 1, skipped: 0 }) },
    ]);
    renderAt('/about');

    await vi.waitFor(() => expect(localStorage.getItem('spinmatch:history')).toBeNull());
    const posts = calls.filter((c) => c.url === '/api/history/import');
    expect(posts.length).toBeGreaterThan(1);
    for (const post of posts) {
      expect(new TextEncoder().encode(JSON.stringify(post.body)).length).toBeLessThan(256 * 1024);
    }
    expect(posts.flatMap((p) => p.body.entries)).toEqual(legacy);
  });

  it('renders NotFound for an unknown route', async () => {
    installFetchMock([{ test: isConfig, respond: () => jsonResponse({}) }]);
    renderAt('/no/such/page');

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to search' })).toHaveAttribute('href', '/');
    // Set in an effect, which can land just after the heading renders.
    await waitFor(() => expect(document.title).toBe('Not found · Spinmatch'));
  });
});
