import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { ConfigProvider } from './ConfigContext.jsx';
import { useAuth } from './AuthContext.jsx';
import SetupPage from './pages/SetupPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import EqualizerLoader from './components/EqualizerLoader.jsx';

// Decides what the whole app renders based on auth state: a brief loader while
// status is unknown, first-run setup, login, or the full application.
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
