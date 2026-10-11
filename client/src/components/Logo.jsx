// Ring (MusicBrainz metadata) around a play triangle (YouTube).
export default function Logo({ size = 32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className="app-mark" aria-hidden="true">
      <circle cx="16" cy="16" r="14.5" fill="none" stroke="var(--signal)" strokeWidth="2.2" />
      <path d="M13 10.5L21.5 16L13 21.5V10.5Z" fill="var(--lock)" />
    </svg>
  );
}
