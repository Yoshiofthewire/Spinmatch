import CoverArt from '../CoverArt.jsx';
import { coverUrl } from '../../api/library.js';

// Embedded or sidecar art; the endpoint 204s to the placeholder when neither exists.
export default function LocalCover({ trackId, alt }) {
  return <CoverArt src={trackId ? coverUrl(trackId) : null} alt={alt} />;
}
