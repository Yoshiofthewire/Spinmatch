import { useEffect, useState } from 'react';
import EqualizerLoader from './EqualizerLoader.jsx';

// `initialValue` is the query in the URL; the input follows it when Back/Forward
// changes it, and is free-typed otherwise.
export default function SearchBox({ onSearch, loading, initialValue = '' }) {
  const [value, setValue] = useState(initialValue);
  useEffect(() => { setValue(initialValue); }, [initialValue]);

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
