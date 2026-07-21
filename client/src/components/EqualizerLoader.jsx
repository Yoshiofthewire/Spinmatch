// A small animated bar visualizer used anywhere the app is actively listening —
// searching MusicBrainz or matching a track against YouTube.
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
