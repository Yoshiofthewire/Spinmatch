import { createContext, useContext, useEffect, useState } from 'react';
import { get } from './api/client.js';

const ConfigContext = createContext({ metubeUrl: null });

export function ConfigProvider({ children }) {
  const [config, setConfig] = useState({ metubeUrl: null });

  useEffect(() => {
    get('/config')
      .then(setConfig)
      .catch(() => {}); // MeTube integration is optional; silently stay disabled on failure
  }, []);

  return <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>;
}

export function useConfig() {
  return useContext(ConfigContext);
}
