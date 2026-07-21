import { usePagination } from '../lib/usePagination.js';
import Pagination from './Pagination.jsx';

export default function ResultsGroup({ title, items, renderItem, emptyText }) {
  const { page, setPage, pageCount, pageItems } = usePagination(items || [], 20);

  if (!items) return null;

  return (
    <section className="results-group">
      <h2>{title}</h2>
      {items.length === 0 ? (
        <p className="muted">{emptyText || 'No results'}</p>
      ) : (
        <>
          <ul className="results-list">
            {pageItems.map((item) => (
              <li key={item.mbid}>{renderItem(item)}</li>
            ))}
          </ul>
          <Pagination page={page} pageCount={pageCount} onChange={setPage} />
        </>
      )}
    </section>
  );
}
