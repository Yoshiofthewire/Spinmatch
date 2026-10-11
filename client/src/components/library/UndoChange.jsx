import { useState } from 'react';
import ErrorBanner from '../ErrorBanner.jsx';
import { undoChange } from '../../api/library.js';

const files = (n) => `${n} file${n === 1 ? '' : 's'}`;

// Undo one journaled tag write, behind an inline confirm. Files changed since are
// skipped by the server and listed here.
export default function UndoChange({ batchId, onUndone }) {
  const [stage, setStage] = useState('idle'); // idle | confirm | running | done
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function run() {
    setStage('running');
    setError(null);
    try {
      const undone = await undoChange(batchId);
      setResult(undone);
      setStage('done');
      onUndone?.(undone);
    } catch (err) {
      setError(err.message);
      setStage('confirm');
    }
  }

  if (stage === 'done') {
    const skipped = [...result.conflicts, ...result.failed];
    return (
      <div>
        <p className={`banner ${result.undone ? 'banner-success' : 'banner-error'}`}>
          {`Put back the previous tags on ${files(result.undone)}.`}
        </p>
        {skipped.length > 0 && (
          <div className="banner banner-error">
            <p>{`${files(skipped.length)} left as they are:`}</p>
            <ul>
              {skipped.map((s) => (
                <li key={s.path} className="mono">{`${s.path}: ${s.reason ?? s.message}`}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  const running = stage === 'running';
  return (
    <div className="undo-change">
      {stage === 'idle' ? (
        <button type="button" className="chip-button" onClick={() => setStage('confirm')}>
          Undo
        </button>
      ) : (
        <span>
          <span className="muted">Put the previous tags back? </span>
          <button type="button" className="chip-button" disabled={running} onClick={run}>
            {running ? 'Undoing…' : 'Confirm undo'}
          </button>
          <button type="button" className="link-button" disabled={running} onClick={() => setStage('idle')}>
            Cancel
          </button>
        </span>
      )}
      {error && <ErrorBanner message={error} />}
    </div>
  );
}
