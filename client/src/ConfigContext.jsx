import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { get } from './api/client.js';

const ConfigContext = createContext({
  ingestEnabled: false, libraryEnabled: false, acoustidConfigured: false,
  loading: false, error: null, retry: () => {},
});

export function ConfigProvider({ children }) {
  const [config, setConfig] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    get('/config')
      .then((c) => { if (!cancelled) setConfig(c); })
      .catch((err) => { if (!cancelled) setError(err); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return (
    <ConfigContext.Provider value={{ ...config, loading, error, retry }}>
      {children}
    </ConfigContext.Provider>
  );
}

export function useConfig() {
  return useContext(ConfigContext);
}
