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
import Logo from './components/Logo.jsx';
import { useConfig } from './ConfigContext.jsx';
import { useAuth } from './AuthContext.jsx';

function navLinkClass({ isActive }) {
  return isActive ? 'nav-link nav-link-active' : 'nav-link';
}

export default function App() {
  const { ingestEnabled, libraryEnabled } = useConfig();
  const { username, logout } = useAuth();

  return (
    <div className="app">
      <header className="app-header">
        {/* A router link, not an <a href>: a full page reload would throw away
            the history the Back button walks. */}
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
        </Routes>
      </main>
    </div>
  );
}
