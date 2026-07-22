import { Link } from 'react-router-dom';

export default function Breadcrumbs({ crumbs }) {
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      {crumbs.map((crumb, i) => {
        const isLast = i === crumbs.length - 1;
        return (
          <span key={i} className="breadcrumb-item">
            {isLast || !crumb.to ? (
              <span aria-current={isLast ? 'page' : undefined}>{crumb.label}</span>
            ) : (
              <Link to={crumb.to}>{crumb.label}</Link>
            )}
            {!isLast && <span className="breadcrumb-sep"> / </span>}
          </span>
        );
      })}
    </nav>
  );
}
