// Marks an owned search result; renders nothing otherwise.
export default function OwnedBadge({ owned, label = 'In your library' }) {
  if (!owned) return null;
  return <span className="badge badge-owned">{label}</span>;
}
