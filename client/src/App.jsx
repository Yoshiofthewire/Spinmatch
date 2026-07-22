import { Routes, Route, NavLink } from 'react-router-dom';
import SearchPage from './pages/SearchPage.jsx';
import ArtistPage from './pages/ArtistPage.jsx';
import AlbumPage from './pages/AlbumPage.jsx';
import HistoryPage from './pages/HistoryPage.jsx';
import AboutPage from './pages/AboutPage.jsx';
import Logo from './components/Logo.jsx';

function navLinkClass({ isActive }) {
  return isActive ? 'nav-link nav-link-active' : 'nav-link';
}

export default function App() {
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
          <NavLink to="/history" className={navLinkClass}>History</NavLink>
          <NavLink to="/about" className={navLinkClass}>About</NavLink>
        </nav>
      </header>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<SearchPage />} />
          <Route path="/artist/:mbid" element={<ArtistPage />} />
          <Route path="/release-group/:mbid" element={<AlbumPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/about" element={<AboutPage />} />
        </Routes>
      </main>
    </div>
  );
}
