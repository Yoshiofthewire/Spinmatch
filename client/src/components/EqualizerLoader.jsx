// Loading indicator for MusicBrainz/YouTube lookups.
export default function EqualizerLoader({ label }) {
  return (
    <span className="loading-row" role="status">
      <span className="eq-loader" aria-hidden="true">
        <span className="eq-bar" />
        <span className="eq-bar" />
        <span className="eq-bar" />
        <span className="eq-bar" />
      </span>
      {label && <span>{label}</span>}
    </span>
  );
}
