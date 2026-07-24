import { useState } from 'react';
import { setupAdmin } from '../api/auth.js';
import { useAuth } from '../AuthContext.jsx';
import Logo from '../components/Logo.jsx';

const MIN_PASSWORD_LENGTH = 8;

export default function SetupPage() {
  const { refresh } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await setupAdmin({ username: username.trim(), password });
      await refresh(); // flips the gate to the authenticated app
    } catch (err) {
      setError(err.message || 'Could not create the account.');
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={handleSubmit}>
        <Logo />
        <h1>Welcome to Spinmatch</h1>
        <p className="muted">Create an admin account to secure this instance. This is a one-time setup.</p>
        {error && <div className="banner banner-error">{error}</div>}
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
        </label>
        <label>
          Confirm password
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        </label>
        <button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
      </form>
    </div>
  );
}
