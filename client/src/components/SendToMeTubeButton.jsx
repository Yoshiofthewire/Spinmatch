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
      const res = await fetch(`${metubeUrl}/add`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
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
