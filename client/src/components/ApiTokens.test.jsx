import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ApiTokens from './ApiTokens.jsx';
import { installFetchMock, jsonResponse } from '../test/fetchMock.js';

afterEach(cleanup);

const SECRET = 'spm_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const EXISTING = { id: 1, name: 'grafana', scope: 'read', createdAt: 1, lastUsedAt: null, revokedAt: null };
const NEW_META = { id: 2, name: 'backup script', scope: 'full', createdAt: 2, lastUsedAt: null, revokedAt: null };

const list = (tokens) => ({
  method: 'GET', test: (url) => url === '/api/tokens', respond: () => jsonResponse({ tokens }),
});

describe('ApiTokens', () => {
  it('creates a token and shows it once, never from the list', async () => {
    const calls = installFetchMock([
      list([EXISTING]),
      { method: 'POST', test: (url) => url === '/api/tokens', respond: () => jsonResponse({ token: SECRET, ...NEW_META }) },
      list([NEW_META, EXISTING]),
    ]);
    const user = userEvent.setup();
    render(<ApiTokens />);
    await screen.findByText('grafana');

    expect(screen.getByLabelText('Read-only')).toBeChecked();
    await user.type(screen.getByLabelText('Token name'), 'backup script');
    await user.click(screen.getByLabelText('Full access'));
    await user.click(screen.getByRole('button', { name: 'Create token' }));

    expect(await screen.findByText(SECRET)).toBeInTheDocument();
    expect(screen.getByText(/will not be shown again/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST').body).toEqual({ name: 'backup script', scope: 'full' });
    expect(await screen.findByRole('cell', { name: 'backup script' })).toBeInTheDocument();
    // Form resets to the safe default.
    expect(screen.getByLabelText('Read-only')).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
  });

  it('revokes one token only after an inline confirm', async () => {
    const calls = installFetchMock([
      list([EXISTING]),
      { method: 'DELETE', test: (url) => url === '/api/tokens/1', respond: () => jsonResponse({ ok: true }) },
      list([{ ...EXISTING, revokedAt: 3 }]),
    ]);
    const user = userEvent.setup();
    render(<ApiTokens />);

    await user.click(await screen.findByRole('button', { name: 'Revoke' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await user.click(screen.getByRole('button', { name: 'Confirm revoke' }));
    expect(await screen.findByText(/^Revoked/)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['/api/tokens/1']);
  });

  it('revokes all tokens after an inline confirm', async () => {
    const calls = installFetchMock([
      list([EXISTING, NEW_META]),
      { method: 'DELETE', test: (url) => url === '/api/tokens', respond: () => jsonResponse({ revoked: 2 }) },
      list([]),
    ]);
    const user = userEvent.setup();
    render(<ApiTokens />);

    await user.click(await screen.findByRole('button', { name: 'Revoke all tokens' }));
    expect(screen.getByText('Revoke all 2 active tokens?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm revoke all' }));
    await waitFor(() => expect(screen.queryByText('grafana')).not.toBeInTheDocument());
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['/api/tokens']);
  });

  it('shows a server refusal in the error banner', async () => {
    installFetchMock([
      list([]),
      {
        method: 'POST',
        test: (url) => url === '/api/tokens',
        respond: () => jsonResponse({ error: { code: 'BAD_REQUEST', message: 'A token name is 1-64 characters' } }, { status: 400 }),
      },
    ]);
    const user = userEvent.setup();
    render(<ApiTokens />);
    await user.type(screen.getByLabelText('Token name'), 'x');
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A token name is 1-64 characters');
  });
});
