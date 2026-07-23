import IngestPanel from '../components/IngestPanel.jsx';

export default function IngestPage() {
  return (
    <div className="ingest-page">
      <h1>Ingest</h1>
      <p className="muted">
        Drop new audio (loose files or album folders) into your configured ingest folder, then
        scan and process it here. Confirmed tracks get their missing tags filled in; anything
        that can't be confidently identified is left untouched and listed below for review.
      </p>
      <IngestPanel />
    </div>
  );
}
