import { Routes, Route, NavLink, Link } from 'react-router-dom';
import SearchPage from './pages/SearchPage.jsx';
import ArtistPage from './pages/ArtistPage.jsx';
import AlbumPage from './pages/AlbumPage.jsx';
import HistoryPage from './pages/HistoryPage.jsx';
import AboutPage from './pages/AboutPage.jsx';
import AccountPage from './pages/AccountPage.jsx';
import IngestPage from './pages/IngestPage.jsx';
import LibraryPage from './pages/LibraryPage.jsx';
import PlaylistsPage from './pages/PlaylistsPage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';
import Logo from './components/Logo.jsx';
import EqualizerLoader from './components/EqualizerLoader.jsx';
import ErrorBanner from './components/ErrorBanner.jsx';
import { useConfig } from './ConfigContext.jsx';
import { useAuth } from './AuthContext.jsx';

function navLinkClass({ isActive }) {
  return isActive ? 'nav-link nav-link-active' : 'nav-link';
}

export default function App() {
  const { ingestEnabled, libraryEnabled, loading, error, retry } = useConfig();
  const { username, logout } = useAuth();

  return (
    <div className="app">
      <header className="app-header">
        {/* Router link: a full reload would lose Back history. */}
        <Link to="/" className="app-brand">
          <Logo />
          <span className="app-title">Spinmatch</span>
        </Link>
        <p className="app-subtitle">Track down the right take</p>
        <nav className="app-nav">
          <NavLink to="/" end className={navLinkClass}>Search</NavLink>
          {ingestEnabled && <NavLink to="/ingest" className={navLinkClass}>Ingest</NavLink>}
          {libraryEnabled && <NavLink to="/library" className={navLinkClass}>Library</NavLink>}
          {libraryEnabled && <NavLink to="/playlists" className={navLinkClass}>Playlists</NavLink>}
          <NavLink to="/history" className={navLinkClass}>History</NavLink>
          <NavLink to="/about" className={navLinkClass}>About</NavLink>
          <NavLink to="/account" className={navLinkClass}>
            {username ? `Account (${username})` : 'Account'}
          </NavLink>
          <button type="button" className="nav-logout" onClick={logout}>
            Log out
          </button>
        </nav>
      </header>
      <main className="app-main">
        {/* Routes depend on config, so none render until it has loaded. */}
        {loading ? (
          <EqualizerLoader label="Loading…" />
        ) : error ? (
          <ErrorBanner message={`Couldn't load settings: ${error.message}`} onRetry={retry} />
        ) : (
          <Routes>
            <Route path="/" element={<SearchPage />} />
            <Route path="/artist/:mbid" element={<ArtistPage />} />
            <Route path="/release-group/:mbid" element={<AlbumPage />} />
            {ingestEnabled && <Route path="/ingest" element={<IngestPage />} />}
            {libraryEnabled && <Route path="/library" element={<LibraryPage />} />}
            {libraryEnabled && <Route path="/playlists" element={<PlaylistsPage />} />}
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/about" element={<AboutPage />} />
            <Route path="/account" element={<AccountPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        )}
      </main>
    </div>
  );
}
