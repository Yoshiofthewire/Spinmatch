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
        MIT License
        <br/>
        Copyright (c) 2026 Yoshiofthewire
        <br/>
        Permission is hereby granted, free of charge, to any person obtaining a copy
        of this software and associated documentation files (the "Software"), to deal
        in the Software without restriction, including without limitation the rights
        to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
        copies of the Software, and to permit persons to whom the Software is
        furnished to do so, subject to the following conditions:
        <br/>
        The above copyright notice and this permission notice shall be included in all
        copies or substantial portions of the Software.
        <br/>
        THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
        IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
        FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
        AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
        LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
        OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
        SOFTWARE.
      </p>
    </div>
  );
}
