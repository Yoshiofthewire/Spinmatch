import { useState } from 'react';
import EqualizerLoader from './EqualizerLoader.jsx';

// `initialValue` only seeds the input on first mount (useState reads it once) —
// it's for a caller that arrives with a query already decided (a link into
// `/?q=...`), not a controlled value that would need to track further changes.
export default function SearchBox({ onSearch, loading, initialValue = '' }) {
  const [value, setValue] = useState(initialValue);

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
