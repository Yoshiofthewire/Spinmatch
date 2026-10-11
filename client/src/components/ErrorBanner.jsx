// The app's error state: a message, and a way to try again when there is one.
export default function ErrorBanner({ message, onRetry }) {
  return (
    <div className="banner banner-error" role="alert">
      {message}
      {onRetry && (
        <>
          {' '}
          <button type="button" className="chip-button" onClick={onRetry}>Retry</button>
        </>
      )}
    </div>
  );
}
