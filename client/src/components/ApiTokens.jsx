import { useCallback, useEffect, useState } from 'react';
import CopyButton from './CopyButton.jsx';
import ErrorBanner from './ErrorBanner.jsx';
import { listTokens, createToken, revokeToken, revokeAllTokens } from '../api/tokens.js';

const when = (ms) => (ms ? new Date(ms).toLocaleString() : 'never');

export default function ApiTokens() {
  const [tokens, setTokens] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [scope, setScope] = useState('read');
  const [created, setCreated] = useState(null); // the one response that carries the token
  const [confirming, setConfirming] = useState(null); // token id | 'all'

  const load = useCallback(async () => {
    setTokens((await listTokens()).tokens);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, [load]);

  async function act(fn) {
    setError(null);
    setBusy(true);
    try {
      await fn();
      setConfirming(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function submit(e) {
    e.preventDefault();
    act(async () => {
      setCreated(await createToken(name.trim(), scope));
      setName('');
      setScope('read');
    });
  }

  const active = tokens.filter((t) => !t.revokedAt);

  return (
    <section className="account-form">
      <h2>API tokens</h2>
      <p className="muted">
        For scripts: send <span className="mono">Authorization: Bearer &lt;token&gt;</span>. A token
        cannot sign in, change the password, or manage tokens. Signing out and changing the password
        do not revoke tokens; revoke them here.
      </p>

      {error && <ErrorBanner message={error} />}

      {created && (
        <div className="banner banner-success">
          <p>Copy the token for “{created.name}” now. It will not be shown again.</p>
          <code className="mono">{created.token}</code>
          {' '}
          <CopyButton text={created.token} />
          {' '}
          <button type="button" className="chip-button" onClick={() => setCreated(null)}>Done</button>
        </div>
      )}

      <form onSubmit={submit}>
        <label>
          Token name
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} required />
        </label>
        <fieldset>
          <legend>Access</legend>
          <label>
            <input type="radio" name="scope" checked={scope === 'read'} onChange={() => setScope('read')} />
            {' '}Read-only
          </label>
          <label>
            <input type="radio" name="scope" checked={scope === 'full'} onChange={() => setScope('full')} />
            {' '}Full access
          </label>
        </fieldset>
        <button type="submit" disabled={busy || !name.trim()}>Create token</button>
      </form>

      {tokens.length > 0 && (
        <table className="library-table">
          <thead>
            <tr><th>Name</th><th>Access</th><th>Created</th><th>Last used</th><th aria-label="Actions" /></tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td>{t.scope === 'full' ? 'Full access' : 'Read-only'}</td>
                <td className="muted">{when(t.createdAt)}</td>
                <td className="muted">{when(t.lastUsedAt)}</td>
                <td>
                  {t.revokedAt ? (
                    <span className="muted">Revoked {when(t.revokedAt)}</span>
                  ) : confirming === t.id ? (
                    <>
                      <button type="button" className="chip-button" disabled={busy} onClick={() => act(() => revokeToken(t.id))}>
                        Confirm revoke
                      </button>
                      {' '}
                      <button type="button" className="chip-button" onClick={() => setConfirming(null)}>Cancel</button>
                    </>
                  ) : (
                    <button type="button" className="chip-button" onClick={() => setConfirming(t.id)}>Revoke</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {active.length > 0 && (confirming === 'all' ? (
        <p>
          Revoke all {active.length} active token{active.length === 1 ? '' : 's'}?{' '}
          <button type="button" disabled={busy} onClick={() => act(revokeAllTokens)}>Confirm revoke all</button>
          {' '}
          <button type="button" className="chip-button" onClick={() => setConfirming(null)}>Cancel</button>
        </p>
      ) : (
        <button type="button" onClick={() => setConfirming('all')}>Revoke all tokens</button>
      ))}
    </section>
  );
}
