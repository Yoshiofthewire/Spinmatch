import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SingleSignOn from './SingleSignOn.jsx';
import { installFetchMock, jsonResponse } from '../test/fetchMock.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LINK = { issuer: 'https://auth.example', sub: 'user-1' };
const getLink = (body) => ({ method: 'GET', test: (url) => url === '/api/auth/oidc/link', respond: () => jsonResponse(body) });

function stubLocation(search = '') {
  const assign = vi.fn();
  vi.stubGlobal('location', { search, assign });
  return assign;
}

describe('SingleSignOn', () => {
  it('starts a link round trip and navigates to the identity provider', async () => {
    const assign = stubLocation();
    const calls = installFetchMock([
      getLink({ link: null, only: false }),
      { method: 'POST', test: (url) => url === '/api/auth/oidc/link', respond: () => jsonResponse({ url: 'https://auth.example/authorize?x=1' }) },
    ]);
    const user = userEvent.setup();
    render(<SingleSignOn />);

    await user.click(await screen.findByRole('button', { name: 'Link identity' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://auth.example/authorize?x=1'));
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
  });

  it('shows the linked identity and unlinks only after confirming', async () => {
    stubLocation('?sso_linked=1');
    const calls = installFetchMock([
      getLink({ link: LINK, only: true }),
      { method: 'DELETE', test: (url) => url === '/api/auth/oidc/link', respond: () => jsonResponse({ ok: true }) },
      getLink({ link: null, only: true }),
    ]);
    const user = userEvent.setup();
    render(<SingleSignOn />);

    expect(await screen.findByText('https://auth.example')).toBeInTheDocument();
    expect(screen.getByText('user-1')).toBeInTheDocument();
    expect(screen.getByText('Identity linked.')).toBeInTheDocument();
    expect(screen.getByText(/OIDC_ONLY is on/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Unlink' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Confirm unlink' }));

    expect(await screen.findByRole('button', { name: 'Link identity' })).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('cancel leaves the link alone', async () => {
    stubLocation();
    const calls = installFetchMock([getLink({ link: LINK, only: false })]);
    const user = userEvent.setup();
    render(<SingleSignOn />);

    await user.click(await screen.findByRole('button', { name: 'Unlink' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Unlink' })).toBeInTheDocument();
    expect(calls).toHaveLength(1);
    expect(screen.queryByText(/OIDC_ONLY/)).toBeNull();
  });

  it('shows a link failure from the callback as fixed text', async () => {
    stubLocation('?sso_error=expired');
    installFetchMock([getLink({ link: null, only: false })]);
    render(<SingleSignOn />);
    expect(await screen.findByText('That sign-in expired or was already used. Try again.')).toBeInTheDocument();
  });
});
