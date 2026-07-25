import CoverArt from '../CoverArt.jsx';
import { coverUrl } from '../../api/library.js';

// Album art for a local file, served by /api/library/cover/:trackId — embedded
// art if the file has any, otherwise a cover image sitting beside it. The
// endpoint answers 204 when there's neither, which lands on the same placeholder
// CoverArt falls back to. A null trackId skips the request entirely.
export default function LocalCover({ trackId, alt }) {
  return <CoverArt src={trackId ? coverUrl(trackId) : null} alt={alt} />;
}
