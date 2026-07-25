import { Routes, Route, NavLink } from 'react-router-dom';
import SearchPage from './pages/SearchPage.jsx';
import ArtistPage from './pages/ArtistPage.jsx';
import AlbumPage from './pages/AlbumPage.jsx';
import HistoryPage from './pages/HistoryPage.jsx';
import AboutPage from './pages/AboutPage.jsx';
import AccountPage from './pages/AccountPage.jsx';
import IngestPage from './pages/IngestPage.jsx';
import LibraryPage from './pages/LibraryPage.jsx';
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
        <a href="/" className="app-brand">
          <Logo />
          <span className="app-title">Spinmatch</span>
        </a>
        <p className="app-subtitle">Track down the right take — matched against MusicBrainz, verified by length</p>
        <nav className="app-nav">
          <NavLink to="/" end className={navLinkClass}>Search</NavLink>
          {ingestEnabled && <NavLink to="/ingest" className={navLinkClass}>Ingest</NavLink>}
          {libraryEnabled && <NavLink to="/library" className={navLinkClass}>Library</NavLink>}
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
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="/account" element={<AccountPage />} />
        </Routes>
      </main>
    </div>
  );
}
