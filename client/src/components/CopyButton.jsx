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
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // navigator.clipboard needs a secure context; execCommand covers plain-HTTP LAN.
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(textarea);
        if (!ok) throw new Error('execCommand copy failed');
      }
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
