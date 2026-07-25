import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

// Same ESM-mocking dance as ingest.test.js: `t.mock.module` intercepts *future*
// resolutions, so tagMatch.js must be re-imported per test with a cache-busting
// query to link against that test's musicbrainz/tags mocks.
let importCounter = 0;
async function freshTagMatch() {
  importCounter += 1;
  return import(`../src/services/tagMatch.js?fresh=${importCounter}`);
}

function tagsMock(readTags) {
  return { exports: { readTags } };
}

function fileTags(overrides = {}) {
  return {
    artist: 'The Band', title: 'Opener', album: 'An Album', trackNumber: null,
    disc: null, year: null, genre: null, durationMs: 180000, hasCoverArt: false,
    ...overrides,
  };
}

test('identifyFileFromTags confirms the recording whose title and duration agree with the tags', async (t) => {
  const queries = [];
  t.mock.module('../src/services/tags.js', tagsMock(async () => fileTags()));
  t.mock.module('../src/services/musicbrainz.js', {
    exports: {
      searchRecordings: async (query) => {
        queries.push(query);
        return [
          { mbid: 'rec-live', title: 'Opener', artist: 'The Band', lengthMs: 300000, score: 100, releaseGroupTitle: 'Live' },
          { mbid: 'rec-studio', title: 'Opener (Remastered)', artist: 'The Band', lengthMs: 181000, score: 90, releaseGroupTitle: 'An Album' },
        ];
      },
      getRecording: async (mbid) => ({ mbid, title: 'Opener', artist: 'The Band', lengthMs: 181000, releaseGroups: [], date: null }),
    },
  });

  const { identifyFileFromTags } = await freshTagMatch();
  const { confirmed, reason } = await identifyFileFromTags('/ingest/opener.mp3');

  assert.equal(reason, null);
  // The 300s "Opener" scores higher at MusicBrainz but is 2 minutes off; the
  // remaster is within tolerance and normalizes to the same title.
  assert.equal(confirmed.mbid, 'rec-studio');
  assert.match(queries[0], /recording:"Opener"/);
  assert.match(queries[0], /artist:"The Band"/);
});

test('identifyFileFromTags refuses a candidate whose duration is outside tolerance', async (t) => {
  t.mock.module('../src/services/tags.js', tagsMock(async () => fileTags()));
  t.mock.module('../src/services/musicbrainz.js', {
    exports: {
      searchRecordings: async () => [
        { mbid: '77777777-7777-4777-8777-777777777777', title: 'Opener', artist: 'The Band', lengthMs: 240000, score: 100, releaseGroupTitle: null },
      ],
      getRecording: async () => { throw new Error('should not resolve an unconfirmed candidate'); },
    },
  });

  const { identifyFileFromTags } = await freshTagMatch();
  const { confirmed, reason } = await identifyFileFromTags('/ingest/opener.mp3');

  assert.equal(confirmed, null);
  assert.match(reason, /tags and duration/i);
});

test('identifyFileFromTags refuses a candidate with a different title even at the same duration', async (t) => {
  t.mock.module('../src/services/tags.js', tagsMock(async () => fileTags()));
  t.mock.module('../src/services/musicbrainz.js', {
    exports: {
      searchRecordings: async () => [
        { mbid: '77777777-7777-4777-8777-777777777777', title: 'A Different Song', artist: 'The Band', lengthMs: 180000, score: 100, releaseGroupTitle: null },
      ],
      getRecording: async () => { throw new Error('should not resolve an unconfirmed candidate'); },
    },
  });

  const { identifyFileFromTags } = await freshTagMatch();
  const { confirmed } = await identifyFileFromTags('/ingest/opener.mp3');

  assert.equal(confirmed, null);
});

test('identifyFileFromTags reports a reason without searching when artist/title tags are missing', async (t) => {
  let searched = false;
  t.mock.module('../src/services/tags.js', tagsMock(async () => fileTags({ artist: null, title: null })));
  t.mock.module('../src/services/musicbrainz.js', {
    exports: { searchRecordings: async () => { searched = true; return []; }, getRecording: async () => null },
  });

  const { identifyFileFromTags } = await freshTagMatch();
  const { confirmed, reason } = await identifyFileFromTags('/ingest/untagged.mp3');

  assert.equal(confirmed, null);
  assert.match(reason, /no artist\/title tags/i);
  assert.equal(searched, false, 'MusicBrainz should not be queried with nothing to query on');
});

test('identifyFileFromTags reports a reason when the file duration is unreadable', async (t) => {
  t.mock.module('../src/services/tags.js', tagsMock(async () => fileTags({ durationMs: null })));
  t.mock.module('../src/services/musicbrainz.js', {
    exports: { searchRecordings: async () => [], getRecording: async () => null },
  });

  const { identifyFileFromTags } = await freshTagMatch();
  const { confirmed, reason } = await identifyFileFromTags('/ingest/opener.mp3');

  assert.equal(confirmed, null);
  assert.match(reason, /duration could not be read/i);
});

test('albumCandidatesFromTags returns release groups and orders files by their track-number tags', async (t) => {
  const byPath = {
    '/ingest/album/b.mp3': fileTags({ title: 'Opener', trackNumber: 1, durationMs: 180000 }),
    '/ingest/album/a.mp3': fileTags({ title: 'Closer', trackNumber: 2, durationMs: 200000 }),
  };
  const queries = [];
  t.mock.module('../src/services/tags.js', tagsMock(async (filePath) => byPath[filePath]));
  t.mock.module('../src/services/musicbrainz.js', {
    exports: {
      searchReleaseGroups: async (query) => {
        queries.push(query);
        return [{ mbid: '11111111-1111-4111-8111-111111111111', title: 'An Album', artist: 'The Band', score: 100 }];
      },
    },
  });

  const { albumCandidatesFromTags } = await freshTagMatch();
  const result = await albumCandidatesFromTags(['/ingest/album/a.mp3', '/ingest/album/b.mp3']);

  assert.deepEqual(result.releaseGroupMbids, ['11111111-1111-4111-8111-111111111111']);
  assert.deepEqual(result.perFile.map((f) => f.filePath), ['/ingest/album/b.mp3', '/ingest/album/a.mp3']);
  assert.deepEqual(result.perFile.map((f) => f.durationMs), [180000, 200000]);
  assert.deepEqual(result.perFile.map((f) => f.recMbids), [[], []]);
  assert.match(queries[0], /releasegroup:"An Album"/);
  assert.match(queries[0], /artist:"The Band"/);
});

test('albumCandidatesFromTags reports a reason when the folder has no album tags', async (t) => {
  t.mock.module('../src/services/tags.js', tagsMock(async () => fileTags({ album: null })));
  t.mock.module('../src/services/musicbrainz.js', {
    exports: { searchReleaseGroups: async () => { throw new Error('should not search without an album tag'); } },
  });

  const { albumCandidatesFromTags } = await freshTagMatch();
  const result = await albumCandidatesFromTags(['/ingest/album/a.mp3']);

  assert.match(result.reason, /no album tags/i);
});

test('albumCandidatesFromTags reports a reason when MusicBrainz knows no such release group', async (t) => {
  t.mock.module('../src/services/tags.js', tagsMock(async () => fileTags()));
  t.mock.module('../src/services/musicbrainz.js', { exports: { searchReleaseGroups: async () => [] } });

  const { albumCandidatesFromTags } = await freshTagMatch();
  const result = await albumCandidatesFromTags(['/ingest/album/a.mp3']);

  assert.match(result.reason, /no MusicBrainz release group/i);
});

test('candidatesFromTags maps search hits onto the picker shape with 0–1 scores', async (t) => {
  t.mock.module('../src/services/tags.js', tagsMock(async () => fileTags()));
  t.mock.module('../src/services/musicbrainz.js', {
    exports: {
      searchRecordings: async () => [
        { mbid: '77777777-7777-4777-8777-777777777777', title: 'Opener', artist: 'The Band', lengthMs: 180000, score: 100, releaseGroupTitle: 'An Album' },
      ],
    },
  });

  const { candidatesFromTags } = await freshTagMatch();
  const { candidates } = await candidatesFromTags('/ingest/opener.mp3');

  assert.deepEqual(candidates, [{
    recordingMbid: '77777777-7777-4777-8777-777777777777', title: 'Opener', artist: 'The Band',
    lengthMs: 180000, score: 1, releaseGroupTitle: 'An Album',
  }]);
});

test('candidatesFromTags returns nothing to pick from when the file has no tags at all', async (t) => {
  t.mock.module('../src/services/tags.js', tagsMock(async () => fileTags({ artist: null, title: null })));
  t.mock.module('../src/services/musicbrainz.js', {
    exports: { searchRecordings: async () => { throw new Error('should not search without tags'); } },
  });

  const { candidatesFromTags } = await freshTagMatch();
  const { candidates } = await candidatesFromTags('/ingest/untagged.mp3');

  assert.deepEqual(candidates, []);
});

// The library's repair flow passes path-derived tags here. Without them a file
// with no artist or title tag returns zero candidates — which is exactly the
// file the Health tab asks you to repair.
test('candidatesFromTags searches on the fallback when the file has no tags of its own', async (t) => {
  const queries = [];
  t.mock.module('../src/services/tags.js', tagsMock(async () => fileTags({ artist: null, title: null })));
  t.mock.module('../src/services/musicbrainz.js', {
    exports: { searchRecordings: async (query) => { queries.push(query); return []; } },
  });

  const { candidatesFromTags } = await freshTagMatch();
  await candidatesFromTags('/music/untagged.mp3', {
    fallback: { artist: 'The Band', title: 'Opener' },
  });

  assert.equal(queries.length, 1, 'the empty tags no longer short-circuit the search');
  assert.match(queries[0], /recording:"Opener"/);
  assert.match(queries[0], /artist:"The Band"/);
});

test('candidatesFromTags prefers a real tag over the fallback', async (t) => {
  const queries = [];
  t.mock.module('../src/services/tags.js', tagsMock(async () => fileTags({ title: 'Real Title' })));
  t.mock.module('../src/services/musicbrainz.js', {
    exports: { searchRecordings: async (query) => { queries.push(query); return []; } },
  });

  const { candidatesFromTags } = await freshTagMatch();
  await candidatesFromTags('/music/tagged.mp3', {
    fallback: { artist: 'Wrong Band', title: 'Wrong Title' },
  });

  assert.match(queries[0], /recording:"Real Title"/);
  assert.match(queries[0], /artist:"The Band"/, 'the real artist tag wins too');
  assert.doesNotMatch(queries[0], /Wrong/);
});

test('candidatesFromTags still finds nothing when neither tags nor fallback have anything', async (t) => {
  t.mock.module('../src/services/tags.js', tagsMock(async () => fileTags({ artist: null, title: null })));
  t.mock.module('../src/services/musicbrainz.js', {
    exports: { searchRecordings: async () => { throw new Error('should not search without tags'); } },
  });

  const { candidatesFromTags } = await freshTagMatch();
  const { candidates } = await candidatesFromTags('/music/untagged.mp3', {
    fallback: { artist: null, title: null },
  });

  assert.deepEqual(candidates, []);
});
