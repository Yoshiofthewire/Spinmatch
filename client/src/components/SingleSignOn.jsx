import { useCallback, useEffect, useState } from 'react';
import ErrorBanner from './ErrorBanner.jsx';
import { getSsoLink, startSsoLink, unlinkSso } from '../api/auth.js';
import { ssoErrorMessage } from '../lib/ssoError.js';

// Link or unlink the identity that may sign in as the admin. Rendered only when SSO is on.
export default function SingleSignOn() {
  const [info, setInfo] = useState(null); // { link, only }
  const [error, setError] = useState(() => ssoErrorMessage(window.location.search));
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const justLinked = new URLSearchParams(window.location.search).has('sso_linked');

  const load = useCallback(async () => setInfo(await getSsoLink()), []);

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, [load]);

  async function link() {
    setError(null);
    setBusy(true);
    try {
      // A fresh round trip to the IdP proves this browser holds the identity.
      window.location.assign((await startSsoLink()).url);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  async function unlink() {
    setError(null);
    setBusy(true);
    try {
      await unlinkSso();
      setConfirming(false);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const linked = info?.link;
  return (
    <section className="account-form">
      <h2>Single sign-on</h2>
      {error && <ErrorBanner message={error} />}
      {justLinked && linked && !error && <div className="banner banner-success">Identity linked.</div>}
      {linked ? (
        <>
          <p>
            Linked as <span className="mono">{linked.issuer}</span> · <span className="mono">{linked.sub}</span>
          </p>
          {confirming ? (
            <div>
              <button type="button" className="chip-button" disabled={busy} onClick={unlink}>Confirm unlink</button>
              {' '}
              <button type="button" className="chip-button" onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirming(true)}>Unlink</button>
          )}
        </>
      ) : (
        info && (
          <>
            <p className="muted">Link your identity provider account so you can sign in with it.</p>
            <button type="button" disabled={busy} onClick={link}>Link identity</button>
          </>
        )
      )}
      {info?.only && (
        <p className="muted">
          OIDC_ONLY is on: password sign-in is refused while an identity is linked. To recover, unset
          OIDC_ONLY and restart the server.
        </p>
      )}
    </section>
  );
}
