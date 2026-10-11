import { useTitle } from '../lib/useTitle.js';
import { useState } from 'react';
import { changePassword } from '../api/auth.js';
import { useAuth } from '../AuthContext.jsx';
import ApiTokens from '../components/ApiTokens.jsx';
import SingleSignOn from '../components/SingleSignOn.jsx';

// Password change, which also revokes every other session; SSO link; API tokens.
export default function AccountPage() {
  useTitle('Account');
  const { username, oidc } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [state, setState] = useState('idle'); // idle | busy | done | error
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError('The new passwords do not match.');
      setState('error');
      return;
    }
    setState('busy');
    try {
      await changePassword({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setState('done');
    } catch (err) {
      setError(err.message || 'Could not change the password.');
      setState('error');
    }
  }

  return (
    <div className="account-page">
      <h1>Account</h1>
      <p className="muted">Signed in as {username}.</p>

      <form className="account-form" onSubmit={handleSubmit}>
        <h2>Change password</h2>
        <p className="muted">
          Changing your password signs out every other browser and device. This one
          stays signed in.
        </p>

        {error && <div className="banner banner-error">{error}</div>}
        {state === 'done' && (
          <div className="banner banner-success">
            Password changed. Any other session has been signed out.
          </div>
        )}

        <label>
          Current password
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <label>
          New password
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>
        <label>
          Confirm new password
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>
        <button type="submit" disabled={state === 'busy'}>
          {state === 'busy' ? 'Changing…' : 'Change password'}
        </button>
      </form>

      {oidc?.enabled && <SingleSignOn />}

      <ApiTokens />

      <section className="account-form">
        <h2>Backup</h2>
        <p className="muted">
          A copy of Spinmatch&apos;s database: playlists, history, tag-edit undo, links and
          settings. It also holds your password hash and session secret, so keep it private.
          Your music files are not included.
        </p>
        <a className="button-link" href="/api/backup/download" download>Download database backup</a>
      </section>
    </div>
  );
}
