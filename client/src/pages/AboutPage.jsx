export default function AboutPage() {
  return (
    <div className="about-page">
      <h1>About Spinmatch</h1>
      <p>
        Search MusicBrainz for an artist, album, or song, browse album art and tracklists, and get
        a YouTube link for a track — verified by cross-checking the video's duration against the
        MusicBrainz-recorded track length.
      </p>
      <p>
        <strong>Spinmatch only finds and verifies YouTube links. It does not download or rip audio.</strong>
      </p>
      <p className="muted">
        Verification looks up each track via yt-dlp, not an official API — heavy use
        (especially bulk album verification) may be temporarily rate-limited by YouTube.
      </p>
      <p className="muted">
        If a MeTube instance is configured, a "Send to MeTube" button appears next to verified
        results so you can queue a download there directly.
      </p>
    </div>
  );
}
