import React from 'react';
import ReactDOM from 'react-dom/client';
import AppGate from './AppGate.jsx';
import { AuthProvider } from './AuthContext.jsx';
import './styles/index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <AppGate />
    </AuthProvider>
  </React.StrictMode>
);
