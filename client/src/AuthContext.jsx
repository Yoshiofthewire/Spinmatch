import { createContext, useContext, useCallback, useEffect, useState } from 'react';
import { getAuthStatus, logout as apiLogout } from './api/auth.js';

const AuthContext = createContext(null);

const INITIAL = { loading: true, setupRequired: false, authenticated: false, username: null };

export function AuthProvider({ children }) {
  const [state, setState] = useState(INITIAL);

  const refresh = useCallback(async () => {
    try {
      const status = await getAuthStatus();
      setState({
        loading: false,
        setupRequired: Boolean(status.setupRequired),
        authenticated: Boolean(status.authenticated),
        username: status.username ?? null,
      });
    } catch {
      // On failure, treat as unauthenticated: show login, not a broken shell.
      setState({ loading: false, setupRequired: false, authenticated: false, username: null });
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Any 401 re-checks status, flipping the gate back to login/setup.
  useEffect(() => {
    const onAuthRequired = () => refresh();
    window.addEventListener('spinmatch:auth-required', onAuthRequired);
    return () => window.removeEventListener('spinmatch:auth-required', onAuthRequired);
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } finally {
      await refresh();
    }
  }, [refresh]);

  return (
    <AuthContext.Provider value={{ ...state, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
