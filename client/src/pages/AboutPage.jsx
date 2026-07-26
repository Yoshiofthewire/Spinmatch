const REPO_URL = 'https://github.com/Yoshiofthewire/Spinmatch';

export default function AboutPage() {
  return (
    <div className="about-page">
      <h1>About Spinmatch</h1>

      <p>
        Search MusicBrainz for an artist, album, or song, browse album art and tracklists, and get
        a YouTube link for a track — verified by cross-checking the video's duration against the
        MusicBrainz-recorded track length.
      </p>

      <p className="about-callout">
        Spinmatch only finds and verifies YouTube links. It does not download or rip audio.
      </p>

      <h2>Verification</h2>
      <p className="muted">
        Verification looks up each track via yt-dlp, not an official API — heavy use (especially
        bulk album verification) may be temporarily rate-limited by YouTube.
      </p>

      <h2>License</h2>
      <p className="muted">
        MIT License · Copyright © 2026 Yoshiofthewire ·{' '}
        <a href={REPO_URL} target="_blank" rel="noreferrer">Source on GitHub</a>
      </p>
      {/* The full text has to be here to satisfy the license, but it is
          reference material, not something anyone reads on the way past. */}
      <details className="about-license">
        <summary>Full license text</summary>
        <p>
          Permission is hereby granted, free of charge, to any person obtaining a copy
          of this software and associated documentation files (the "Software"), to deal
          in the Software without restriction, including without limitation the rights
          to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
          copies of the Software, and to permit persons to whom the Software is
          furnished to do so, subject to the following conditions:
        </p>
        <p>
          The above copyright notice and this permission notice shall be included in all
          copies or substantial portions of the Software.
        </p>
        <p>
          THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
          IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
          FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
          AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
          LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
          OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
          SOFTWARE.
        </p>
      </details>
    </div>
  );
}
