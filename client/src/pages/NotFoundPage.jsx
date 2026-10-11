import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <div className="not-found-page">
      <h1>Page not found</h1>
      <p className="muted">Nothing lives at this address.</p>
      <Link to="/">Back to search</Link>
    </div>
  );
}
