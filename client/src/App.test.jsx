import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import App from './App.jsx';
import { ConfigProvider } from './ConfigContext.jsx';
import { installFetchMock, jsonResponse } from './test/fetchMock.js';

vi.mock('./AuthContext.jsx', () => ({ useAuth: () => ({ username: 'me', logout: () => {} }) }));

afterEach(cleanup);

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

  it('renders NotFound for an unknown route', async () => {
    installFetchMock([{ test: isConfig, respond: () => jsonResponse({}) }]);
    renderAt('/no/such/page');

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to search' })).toHaveAttribute('href', '/');
  });
});
