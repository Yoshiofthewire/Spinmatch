// Marks a MusicBrainz search result that's already in the local library.
// Renders nothing when it isn't, so a page can drop it into any row without
// branching at the call site.
export default function OwnedBadge({ owned, label = 'In your library' }) {
  if (!owned) return null;
  return <span className="badge badge-owned">{label}</span>;
}
