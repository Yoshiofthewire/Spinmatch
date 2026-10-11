import { createContext, useContext, useCallback, useEffect, useState } from 'react';
import { getAuthStatus, logout as apiLogout } from './api/auth.js';

const AuthContext = createContext(null);

const NO_SSO = { enabled: false };
const INITIAL = { loading: true, setupRequired: false, authenticated: false, username: null, oidc: NO_SSO };

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
        oidc: status.oidc ?? NO_SSO,
      });
    } catch {
      // On failure, treat as unauthenticated: show login, not a broken shell.
      setState({ loading: false, setupRequired: false, authenticated: false, username: null, oidc: NO_SSO });
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
      const { endSessionUrl } = await apiLogout();
      // Ends the identity provider's session too; it may send the browser back here.
      if (endSessionUrl) window.location.assign(endSessionUrl);
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
