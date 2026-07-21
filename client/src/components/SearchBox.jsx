import { useState } from 'react';
import EqualizerLoader from './EqualizerLoader.jsx';

export default function SearchBox({ onSearch, loading }) {
  const [value, setValue] = useState('');

  function handleSubmit(e) {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed) onSearch(trimmed);
  }

  return (
    <form className="search-box" onSubmit={handleSubmit}>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search for an artist, album, or song…"
        aria-label="Search"
      />
      <button type="submit" disabled={loading}>
        {loading ? <EqualizerLoader /> : 'Search'}
      </button>
    </form>
  );
}
