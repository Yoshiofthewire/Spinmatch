import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher } from 'undici';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const {
  searchAll,
  browseReleaseGroupsByArtist,
  resolvePrimaryReleaseForGroup,
  getReleaseWithTracks,
  getRecording,
} = await import('../src/services/musicbrainz.js');
const { UpstreamUnavailableError } = await import('../src/lib/httpErrors.js');

function mockMusicBrainz() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  return agent.get('https://musicbrainz.org');
}

test('searchAll shapes artists/release-groups/recordings from MusicBrainz responses', async () => {
  const pool = mockMusicBrainz();
  pool.intercept({ path: /\/ws\/2\/artist\?.*query=311-shape-test.*/ }).reply(200, {
    artists: [{ id: 'artist-1', name: '311', disambiguation: 'US rock band', score: '100' }],
  });
  pool.intercept({ path: /\/ws\/2\/release-group\?.*query=311-shape-test.*/ }).reply(200, {
    'release-groups': [
      {
        id: 'rg-1',
        title: 'Music',
        'artist-credit': [{ name: '311' }],
        'first-release-date': '1993-02-09',
        score: '90',
      },
    ],
  });
  pool.intercept({ path: /\/ws\/2\/recording\?.*query=311-shape-test.*/ }).reply(200, {
    recordings: [
      {
        id: 'rec-1',
        title: 'Down',
        'artist-credit': [{ name: '311' }],
        length: 202000,
        score: '85',
        releases: [{ title: 'Music', 'release-group': { title: 'Music' } }],
      },
    ],
  });

  const result = await searchAll('311-shape-test');

  assert.deepEqual(result.artists, [
    { mbid: 'artist-1', name: '311', disambiguation: 'US rock band', score: 100 },
  ]);
  assert.equal(result.releaseGroups[0].mbid, 'rg-1');
  assert.equal(result.releaseGroups[0].artist, '311');
  assert.equal(result.releaseGroups[0].coverArtUrl, '/api/cover/release-group/rg-1');
  assert.equal(result.recordings[0].lengthMs, 202000);
  assert.equal(result.recordings[0].releaseGroupTitle, 'Music');
});

test('searchAll returns empty arrays (not an error) when nothing matches', async () => {
  const pool = mockMusicBrainz();
  pool.intercept({ path: /\/ws\/2\/artist\?.*query=nonexistent-query-xyz.*/ }).reply(200, { artists: [] });
  pool
    .intercept({ path: /\/ws\/2\/release-group\?.*query=nonexistent-query-xyz.*/ })
    .reply(200, { 'release-groups': [] });
  pool
    .intercept({ path: /\/ws\/2\/recording\?.*query=nonexistent-query-xyz.*/ })
    .reply(200, { recordings: [] });

  const result = await searchAll('nonexistent-query-xyz');
  assert.deepEqual(result, { artists: [], releaseGroups: [], recordings: [] });
});

test('a non-2xx MusicBrainz response throws UpstreamUnavailableError', async () => {
  const pool = mockMusicBrainz();
  pool.intercept({ path: /\/ws\/2\/artist\?.*query=error-case-query.*/ }).reply(503, {});
  pool.intercept({ path: /\/ws\/2\/release-group\?.*query=error-case-query.*/ }).reply(503, {});
  pool.intercept({ path: /\/ws\/2\/recording\?.*query=error-case-query.*/ }).reply(503, {});

  await assert.rejects(searchAll('error-case-query'), UpstreamUnavailableError);
});

test('browseReleaseGroupsByArtist filters to studio albums (Album primary type, no secondary type)', async () => {
  const pool = mockMusicBrainz();
  pool.intercept({ path: '/ws/2/artist/artist-albums-test?fmt=json' }).reply(200, {
    id: 'artist-albums-test',
    name: '311',
  });
  pool.intercept({ path: /\/ws\/2\/release-group\?.*artist=artist-albums-test.*/ }).reply(200, {
    'release-groups': [
      { id: 'studio-1', title: 'Music', 'primary-type': 'Album', 'secondary-types': [], 'first-release-date': '1993' },
      { id: 'live-1', title: 'Live Show', 'primary-type': 'Album', 'secondary-types': ['Live'], 'first-release-date': '1994' },
      { id: 'single-1', title: 'A Single', 'primary-type': 'Single', 'secondary-types': [], 'first-release-date': '1995' },
    ],
  });

  const result = await browseReleaseGroupsByArtist('artist-albums-test');
  assert.equal(result.artist.name, '311');
  assert.deepEqual(
    result.albums.map((a) => a.mbid),
    ['studio-1']
  );
});

test('resolvePrimaryReleaseForGroup prefers an Official release', async () => {
  const pool = mockMusicBrainz();
  pool.intercept({ path: /\/ws\/2\/release\?.*release-group=rg-official-test.*/ }).reply(200, {
    releases: [
      { id: 'bootleg-release', status: 'Bootleg' },
      { id: 'official-release', status: 'Official' },
    ],
  });

  const releaseMbid = await resolvePrimaryReleaseForGroup('rg-official-test');
  assert.equal(releaseMbid, 'official-release');
});

test('resolvePrimaryReleaseForGroup returns null when the release group has no releases', async () => {
  const pool = mockMusicBrainz();
  pool.intercept({ path: /\/ws\/2\/release\?.*release-group=rg-empty-test.*/ }).reply(200, { releases: [] });

  const releaseMbid = await resolvePrimaryReleaseForGroup('rg-empty-test');
  assert.equal(releaseMbid, null);
});

test('getReleaseWithTracks flattens media/tracks into a single track list', async () => {
  const pool = mockMusicBrainz();
  pool.intercept({ path: '/ws/2/release/release-tracks-test?inc=recordings%2Bartist-credits&fmt=json' }).reply(200, {
    id: 'release-tracks-test',
    title: 'Music',
    'artist-credit': [{ name: '311' }],
    media: [
      {
        tracks: [
          { position: 1, title: 'Welcome', length: 175054, recording: { id: 'rec-1', length: 175054 } },
          { position: 2, title: 'Freak Out', length: 222816, recording: { id: 'rec-2', length: 222816 } },
        ],
      },
    ],
  });

  const { release, tracks } = await getReleaseWithTracks('release-tracks-test');
  assert.equal(release.artist, '311');
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].title, 'Welcome');
  assert.equal(tracks[0].lengthMs, 175054);
});

test('getRecording flattens a MusicBrainz recording response', async () => {
  const pool = mockMusicBrainz();
  pool.intercept({ path: '/ws/2/recording/rec-mbid-1?inc=artists%2Breleases%2Brelease-groups&fmt=json' }).reply(200, {
    id: 'rec-mbid-1',
    title: 'Getting Recording Test',
    length: 202000,
    'first-release-date': '2001-05-01',
    'artist-credit': [{ name: 'Recording Test Artist' }],
    releases: [
      {
        'release-group': { id: 'rg-mbid-1', title: 'Recording Test Album' },
      },
    ],
  });

  const recording = await getRecording('rec-mbid-1');
  assert.deepEqual(recording, {
    mbid: 'rec-mbid-1',
    title: 'Getting Recording Test',
    lengthMs: 202000,
    artist: 'Recording Test Artist',
    releaseGroups: [{ mbid: 'rg-mbid-1', title: 'Recording Test Album' }],
    date: '2001-05-01',
  });
});
