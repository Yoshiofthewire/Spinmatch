import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { get } from '../api/client.js';
import AlbumGrid from '../components/AlbumGrid.jsx';
import EqualizerLoader from '../components/EqualizerLoader.jsx';
import Breadcrumbs from '../components/Breadcrumbs.jsx';
import { useConfig } from '../ConfigContext.jsx';
import { useOwned } from '../lib/useOwned.js';

export default function ArtistPage() {
  const { mbid } = useParams();
  const { libraryEnabled } = useConfig();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setData(null);
    setError(null);
    get(`/artists/${mbid}/albums`)
      .then(setData)
      .catch(setError);
  }, [mbid]);

  // Turns this page into a coverage view of the artist: which of their albums
  // you have and which you don't, without a second lookup.
  const owned = useOwned({
    enabled: libraryEnabled,
    albums: (data?.albums ?? []).map((a) => ({
      id: a.mbid, artist: data.artist.name, title: a.title,
    })),
  });

  if (error) return <p className="banner banner-error">{error.message}</p>;
  if (!data) return <EqualizerLoader label="Loading albums…" />;

  return (
    <div className="artist-page">
      <Breadcrumbs crumbs={[{ label: 'Home', to: '/' }, { label: data.artist.name || 'Artist' }]} />
      <h1>{data.artist.name || 'Artist'}</h1>
      <AlbumGrid albums={data.albums} ownedMbids={owned} />
    </div>
  );
}
