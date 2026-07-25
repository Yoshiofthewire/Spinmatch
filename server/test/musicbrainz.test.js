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
  creditString,
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
    artists: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: '311', disambiguation: 'US rock band', score: '100' }],
  });
  pool.intercept({ path: /\/ws\/2\/release-group\?.*query=311-shape-test.*/ }).reply(200, {
    'release-groups': [
      {
        id: '11111111-1111-4111-8111-111111111111',
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
        id: '77777777-7777-4777-8777-777777777777',
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
    { mbid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: '311', disambiguation: 'US rock band', score: 100 },
  ]);
  assert.equal(result.releaseGroups[0].mbid, '11111111-1111-4111-8111-111111111111');
  assert.equal(result.releaseGroups[0].artist, '311');
  assert.equal(result.releaseGroups[0].coverArtUrl, '/api/cover/release-group/11111111-1111-4111-8111-111111111111');
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
        position: 1,
        tracks: [
          { position: 1, title: 'Welcome', length: 175054, recording: { id: '77777777-7777-4777-8777-777777777777', length: 175054 } },
          { position: 2, title: 'Freak Out', length: 222816, recording: { id: '88888888-8888-4888-8888-888888888888', length: 222816 } },
        ],
      },
    ],
  });

  const { release, tracks } = await getReleaseWithTracks('release-tracks-test');
  assert.equal(release.artist, '311');
  assert.equal(release.discCount, 1);
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].title, 'Welcome');
  assert.equal(tracks[0].lengthMs, 175054);
  assert.equal(tracks[0].discNumber, 1);
});

test('getReleaseWithTracks tags each track with its disc number on a multi-disc release', async () => {
  const pool = mockMusicBrainz();
  pool.intercept({ path: '/ws/2/release/multi-disc-test?inc=recordings%2Bartist-credits&fmt=json' }).reply(200, {
    id: 'multi-disc-test',
    title: 'Double Album',
    'artist-credit': [{ name: 'The Band' }],
    media: [
      {
        position: 1,
        tracks: [
          { position: 1, title: 'D1T1', length: 180000, recording: { id: 'rec-11', length: 180000 } },
          { position: 2, title: 'D1T2', length: 190000, recording: { id: 'rec-12', length: 190000 } },
        ],
      },
      {
        position: 2,
        tracks: [
          { position: 1, title: 'D2T1', length: 200000, recording: { id: 'rec-21', length: 200000 } },
        ],
      },
    ],
  });

  const { release, tracks } = await getReleaseWithTracks('multi-disc-test');
  assert.equal(release.discCount, 2);
  assert.equal(tracks.length, 3);
  assert.deepEqual(
    tracks.map((t) => ({ disc: t.discNumber, pos: t.position, title: t.title })),
    [
      { disc: 1, pos: 1, title: 'D1T1' },
      { disc: 1, pos: 2, title: 'D1T2' },
      { disc: 2, pos: 1, title: 'D2T1' },
    ]
  );
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

// MusicBrainz models a credit as segments each carrying the text that follows
// it, so joining on '' rendered "Simon & Garfunkel" as "SimonGarfunkel" — and
// did the same to every collaboration, "feat." and "vs" in the library.
test('creditString honours the joinphrase between credited artists', () => {
  assert.equal(
    creditString([{ name: 'Simon', joinphrase: ' & ' }, { name: 'Garfunkel' }]),
    'Simon & Garfunkel',
  );
  assert.equal(
    creditString([{ name: 'Grabbitz', joinphrase: ' feat. ' }, { name: 'REZZ' }]),
    'Grabbitz feat. REZZ',
  );
  assert.equal(creditString([{ name: '311' }]), '311');
});

test('creditString is total over the shapes MusicBrainz can return', () => {
  assert.equal(creditString(undefined), '');
  assert.equal(creditString(null), '');
  assert.equal(creditString([]), '');
  assert.equal(creditString('not an array'), '');
  assert.equal(creditString([{ name: 'Solo', joinphrase: '' }]), 'Solo');
  // A trailing joinphrase on the last segment shouldn't leave dangling text.
  assert.equal(creditString([{ name: 'A', joinphrase: ' & ' }]), 'A &');
});

// The per-track credit was being fetched (inc=artist-credits) and then thrown
// away, leaving bulk repair to fall back on the release's own credit for every
// track. On a compilation that meant writing "Various Artists" into the artist
// tag of every file on the record.
test('getReleaseWithTracks carries each track its own artist credit', async () => {
  const pool = mockMusicBrainz();
  pool.intercept({ path: '/ws/2/release/compilation-test?inc=recordings%2Bartist-credits&fmt=json' }).reply(200, {
    id: 'compilation-test',
    title: 'Now 47',
    'artist-credit': [{ name: 'Various Artists' }],
    media: [
      {
        position: 1,
        tracks: [
          {
            position: 1,
            title: 'Song One',
            length: 1000,
            'artist-credit': [{ name: 'Blur' }],
            recording: { id: 'rec-a', length: 1000 },
          },
          {
            // No track-level credit; the recording carries it instead.
            position: 2,
            title: 'Song Two',
            length: 2000,
            recording: {
              id: 'rec-b',
              length: 2000,
              'artist-credit': [{ name: 'Pulp' }],
            },
          },
          {
            // Neither: the caller falls back to the release credit.
            position: 3,
            title: 'Song Three',
            length: 3000,
            recording: { id: 'rec-c', length: 3000 },
          },
        ],
      },
    ],
  });

  const { release, tracks } = await getReleaseWithTracks('compilation-test');
  assert.equal(release.artist, 'Various Artists');
  assert.equal(tracks[0].artist, 'Blur');
  assert.equal(tracks[1].artist, 'Pulp', 'the recording credit is the fallback');
  assert.equal(tracks[2].artist, null, 'nothing to claim, so the caller decides');
});
