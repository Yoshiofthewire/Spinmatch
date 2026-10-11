import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import LoginPage from './LoginPage.jsx';
import { AuthProvider } from '../AuthContext.jsx';
import { installFetchMock, jsonResponse } from '../test/fetchMock.js';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

function renderWith(oidc) {
  installFetchMock([{
    test: (url) => url === '/api/auth/status',
    respond: () => jsonResponse({ setupRequired: false, authenticated: false, oidc }),
  }]);
  render(<AuthProvider><LoginPage /></AuthProvider>);
}

describe('LoginPage single sign-on', () => {
  it('links to the SSO start route when the server reports it enabled', async () => {
    renderWith({ enabled: true, only: false });
    const link = await screen.findByRole('link', { name: 'Sign in with SSO' });
    expect(link).toHaveAttribute('href', '/api/auth/oidc/start');
  });

  it('hides the SSO link when it is off', async () => {
    renderWith({ enabled: false });
    await screen.findByRole('button', { name: 'Sign in' });
    // Let the status fetch settle before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('link', { name: 'Sign in with SSO' })).toBeNull();
  });

  it('maps a known sso_error code to its fixed message', async () => {
    window.history.replaceState(null, '', '/?sso_error=unlinked');
    renderWith({ enabled: true, only: false });
    expect(await screen.findByText(/This identity isn't linked to Spinmatch/)).toBeInTheDocument();
  });

  it('never renders arbitrary query text', async () => {
    window.history.replaceState(null, '', '/?sso_error=%3Cb%3Eyour%20account%20is%20locked%3C%2Fb%3E');
    renderWith({ enabled: true, only: false });
    expect(await screen.findByText(/Single sign-on failed/)).toBeInTheDocument();
    expect(screen.queryByText(/your account is locked/)).toBeNull();
  });
});
