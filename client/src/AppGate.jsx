import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { ConfigProvider } from './ConfigContext.jsx';
import { useAuth } from './AuthContext.jsx';
import SetupPage from './pages/SetupPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import EqualizerLoader from './components/EqualizerLoader.jsx';

// Renders loader, setup, login, or the app by auth state.
export default function AppGate() {
  const { loading, setupRequired, authenticated } = useAuth();

  if (loading) {
    return <div className="auth-page"><EqualizerLoader label="Loading…" /></div>;
  }
  if (setupRequired) return <SetupPage />;
  if (!authenticated) return <LoginPage />;

  return (
    <ConfigProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ConfigProvider>
  );
}
