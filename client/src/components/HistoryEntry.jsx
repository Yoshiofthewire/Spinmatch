const STATUS = {
  confirmed: ['badge-confirmed', 'Confirmed'],
  unverified: ['badge-unverified', 'Unverified'],
  no_results: ['badge-none', 'No results'],
};

export function HistoryStatus({ status }) {
  if (!STATUS[status]) return null;
  const [className, label] = STATUS[status];
  return <span className={`badge ${className}`}>{label}</span>;
}

// The id comes from yt-dlp output, so it is encoded rather than trusted.
export function YouTubeLink({ videoId }) {
  if (!videoId) return null;
  return (
    <a href={`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`} target="_blank" rel="noreferrer">
      YouTube
    </a>
  );
}
