export default function Pagination({ page, pageCount, onChange }) {
  if (pageCount <= 1) return null;

  return (
    <div className="pagination">
      <button type="button" onClick={() => onChange(page - 1)} disabled={page <= 1}>
        Prev
      </button>
      <span className="muted">
        Page {page} of {pageCount}
      </span>
      <button type="button" onClick={() => onChange(page + 1)} disabled={page >= pageCount}>
        Next
      </button>
    </div>
  );
}
