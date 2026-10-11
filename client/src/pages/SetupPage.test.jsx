import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SetupPage from './SetupPage.jsx';
import { AuthProvider } from '../AuthContext.jsx';
import { installFetchMock, jsonResponse } from '../test/fetchMock.js';

afterEach(cleanup);

const status = (body) => ({ test: (url) => url === '/api/auth/status', respond: () => jsonResponse(body) });

describe('SetupPage', () => {
  it('sends the setup token from the server log with the new account', async () => {
    const calls = installFetchMock([
      status({ setupRequired: true, authenticated: false }),
      { method: 'POST', test: (url) => url === '/api/auth/setup', respond: () => jsonResponse({ ok: true }) },
      status({ setupRequired: false, authenticated: true, username: 'yoshi' }),
    ]);
    const user = userEvent.setup();
    render(<AuthProvider><SetupPage /></AuthProvider>);

    expect(screen.getByText('Printed in the server log (docker logs spinmatch)')).toBeTruthy();
    await user.type(screen.getByLabelText(/Setup token/), ' tok3n ');
    await user.type(screen.getByLabelText('Username'), 'yoshi');
    await user.type(screen.getByLabelText('Password'), 'hunter2hunter2');
    await user.type(screen.getByLabelText('Confirm password'), 'hunter2hunter2');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(calls.filter((c) => c.url === '/api/auth/status')).toHaveLength(2));
    const post = calls.find((c) => c.method === 'POST');
    expect(post.body).toEqual({ username: 'yoshi', password: 'hunter2hunter2', setupToken: 'tok3n' });
  });
});
