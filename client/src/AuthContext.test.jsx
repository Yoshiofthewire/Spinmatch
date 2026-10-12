import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider, useAuth } from './AuthContext.jsx';
import { installFetchMock, jsonResponse } from './test/fetchMock.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function LogoutButton() {
  const { logout } = useAuth();
  return <button type="button" onClick={logout}>Sign out</button>;
}

const status = (authenticated) => ({
  test: (url) => url === '/api/auth/status', respond: () => jsonResponse({ setupRequired: false, authenticated }),
});

async function signOut(logoutBody) {
  const assign = vi.fn();
  vi.stubGlobal('location', { search: '', assign });
  const calls = installFetchMock([
    status(true),
    { method: 'POST', test: (url) => url === '/api/auth/logout', respond: () => jsonResponse(logoutBody) },
    status(false),
  ]);
  render(<AuthProvider><LogoutButton /></AuthProvider>);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
  await waitFor(() => expect(calls.filter((c) => c.url === '/api/auth/status')).toHaveLength(2));
  return assign;
}

describe('logout', () => {
  it('follows the identity provider end-session URL when the server returns one', async () => {
    const assign = await signOut({ ok: true, endSessionUrl: 'https://auth.example/logout?client_id=spinmatch' });
    expect(assign).toHaveBeenCalledWith('https://auth.example/logout?client_id=spinmatch');
  });

  it('stays local otherwise', async () => {
    const assign = await signOut({ ok: true });
    expect(assign).not.toHaveBeenCalled();
  });
});
