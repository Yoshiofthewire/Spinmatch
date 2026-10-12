import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import AccountPage from './AccountPage.jsx';
import { installFetchMock, jsonResponse } from '../test/fetchMock.js';

vi.mock('../AuthContext.jsx', () => ({ useAuth: () => ({ username: 'admin', oidc: { enabled: false } }) }));

afterEach(cleanup);

describe('AccountPage', () => {
  it('offers the database backup as a plain same-origin download', async () => {
    installFetchMock([{ test: (url) => url === '/api/tokens', respond: () => jsonResponse({ tokens: [] }) }]);
    render(<AccountPage />);
    const link = await screen.findByRole('link', { name: 'Download database backup' });
    expect(link).toHaveAttribute('href', '/api/backup/download');
    expect(link).toHaveAttribute('download');
    expect(screen.getByText(/holds your password hash/)).toBeInTheDocument();
  });
});
