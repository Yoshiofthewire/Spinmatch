import { useState } from 'react';
import { login } from '../api/auth.js';
import { useAuth } from '../AuthContext.jsx';
import Logo from '../components/Logo.jsx';

export default function LoginPage() {
  const { refresh } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login({ username: username.trim(), password });
      await refresh(); // flips the gate to the authenticated app
    } catch (err) {
      setError(err.message || 'Could not sign in.');
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={handleSubmit}>
        <Logo />
        <h1>Sign in</h1>
        {error && <div className="banner banner-error">{error}</div>}
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
