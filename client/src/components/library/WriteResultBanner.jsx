// Multi-file write outcome. Writes don't stop at a failure, so always list the
// failed files (server messages carry no absolute paths).
export default function WriteResultBanner({ result, verb = 'Wrote', nothingLabel }) {
  const applied = result.applied?.length ?? 0;
  const failed = result.failed ?? [];

  return (
    <>
      <p className={`banner ${applied === 0 && failed.length ? 'banner-error' : 'banner-success'}`}>
        {applied === 0
          ? (nothingLabel ?? 'Nothing needed changing.')
          : `${verb} ${applied} file${applied === 1 ? '' : 's'}.`}
      </p>
      {failed.length > 0 && (
        <div className="banner banner-error">
          <p>{`${failed.length} file${failed.length === 1 ? '' : 's'} could not be written:`}</p>
          <ul>
            {failed.map((f) => (
              <li key={f.trackId} className="mono">{f.message}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
