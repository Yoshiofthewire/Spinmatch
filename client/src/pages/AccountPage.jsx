import { useState } from 'react';
import { changePassword } from '../api/auth.js';
import { useAuth } from '../AuthContext.jsx';

// Password change, which also revokes every other session. Previously the only
// way to change the credential was to stop the app and edit the database, and
// that route left every already-issued cookie working for its full 30 days.
export default function AccountPage() {
  const { username } = useAuth();
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
    </div>
  );
}
