// The outcome of a write across several files, for the two panels that do one:
// BulkFixPanel (repair) and AlbumTagEditPanel (manual edit).
//
// The failed list is the part that matters and the part that is easy to leave
// out. Neither run stops at the first unwritable file, so without it "Wrote 12
// files" out of 14 selected reads as complete success. The messages come from
// describeFailure on the server and carry no absolute paths.
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
