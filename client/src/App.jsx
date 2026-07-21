import { Routes, Route } from 'react-router-dom';
import SearchPage from './pages/SearchPage.jsx';
import ArtistPage from './pages/ArtistPage.jsx';
import AlbumPage from './pages/AlbumPage.jsx';
import Logo from './components/Logo.jsx';

export default function App() {
  return (
    <div className="app">
      <header className="app-header">
        <a href="/" className="app-brand">
          <Logo />
          <span className="app-title">Tubarr</span>
        </a>
        <p className="app-subtitle">Track down the right take — matched against MusicBrainz, verified by length</p>
      </header>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<SearchPage />} />
          <Route path="/artist/:mbid" element={<ArtistPage />} />
          <Route path="/release-group/:mbid" element={<AlbumPage />} />
        </Routes>
      </main>
    </div>
  );
}
