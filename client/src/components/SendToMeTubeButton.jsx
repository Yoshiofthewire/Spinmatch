import { useState } from 'react';
import { useConfig } from '../ConfigContext.jsx';
import EqualizerLoader from './EqualizerLoader.jsx';

// Posts directly to the user's MeTube instance from the browser (not proxied
// through our backend) so the request carries the browser's own cookies/session
// for that origin, the same way the official MeTube bookmarklet works.
export default function SendToMeTubeButton({ url }) {
  const { metubeUrl } = useConfig();
  const [state, setState] = useState('idle'); // idle | sending | sent | error

  if (!metubeUrl) return null;

  async function handleClick() {
    setState('sending');
    try {
      // No explicit Content-Type: the browser defaults a string body to
      // text/plain, keeping this a CORS "simple request" with no preflight —
      // matching the official MeTube bookmarklet's own XHR call. Setting
      // application/json here would require MeTube to answer an OPTIONS
      // preflight it was never built to handle, breaking the request outright
      // in setups where the plain bookmarklet works fine.
      const res = await fetch(`${metubeUrl}/add`, {
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ url, quality: 'best' }),
      });
      setState(res.ok ? 'sent' : 'error');
    } catch {
      setState('error');
    }
  }

  if (state === 'sending') return <EqualizerLoader label="Sending…" />;
  if (state === 'sent') return <span className="badge badge-confirmed">Sent to MeTube</span>;

  return (
    <button type="button" className="metube-button" onClick={handleClick}>
      {state === 'error' ? 'Retry send to MeTube' : 'Send to MeTube'}
    </button>
  );
}
