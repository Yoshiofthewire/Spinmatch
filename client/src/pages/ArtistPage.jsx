import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { get } from '../api/client.js';
import AlbumGrid from '../components/AlbumGrid.jsx';
import EqualizerLoader from '../components/EqualizerLoader.jsx';

export default function ArtistPage() {
  const { mbid } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setData(null);
    setError(null);
    get(`/artists/${mbid}/albums`)
      .then(setData)
      .catch(setError);
  }, [mbid]);

  if (error) return <p className="banner banner-error">{error.message}</p>;
  if (!data) return <EqualizerLoader label="Loading albums…" />;

  return (
    <div className="artist-page">
      <h1>{data.artist.name || 'Artist'}</h1>
      <AlbumGrid albums={data.albums} />
    </div>
  );
}
