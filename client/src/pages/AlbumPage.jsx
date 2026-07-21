import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { get } from '../api/client.js';
import TrackList from '../components/TrackList.jsx';
import BulkVerifyPanel from '../components/BulkVerifyPanel.jsx';
import EqualizerLoader from '../components/EqualizerLoader.jsx';

export default function AlbumPage() {
  const { mbid } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setData(null);
    setError(null);
    get(`/releases/${mbid}/tracks`)
      .then(setData)
      .catch(setError);
  }, [mbid]);

  if (error) return <p className="banner banner-error">{error.message}</p>;
  if (!data) return <EqualizerLoader label="Loading tracklist…" />;

  return (
    <div className="album-page">
      <h1>{data.release.title}</h1>
      <p className="muted">{data.release.artist}</p>

      <BulkVerifyPanel
        releaseGroupMbid={mbid}
        trackCount={data.tracks.length}
        estimatedQuotaUnits={data.estimatedQuotaUnits}
      />

      <TrackList artist={data.release.artist} album={data.release.title} tracks={data.tracks} />
    </div>
  );
}
