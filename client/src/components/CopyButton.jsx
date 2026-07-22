import { useEffect, useState } from 'react';

export default function CopyButton({ text, label = 'Copy' }) {
  const [state, setState] = useState('idle'); // idle | copied | error

  useEffect(() => {
    if (state === 'idle') return undefined;
    const timer = setTimeout(() => setState('idle'), 1500);
    return () => clearTimeout(timer);
  }, [state]);

  async function handleClick() {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('error');
    }
  }

  if (!text) return null;

  return (
    <button type="button" className="copy-button" onClick={handleClick}>
      {state === 'copied' ? 'Copied!' : state === 'error' ? 'Copy failed' : label}
    </button>
  );
}
