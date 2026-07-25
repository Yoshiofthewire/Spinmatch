// The whole-artist sweep. What matters is that it walks every missing album,
// reports which one it is on as it goes, keeps going when one album can't be
// read, and stops dead on a rate limit rather than hammering the next twenty.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MB_CONTACT_EMAIL = 'test@example.com';

const { openDb, setDbForTest } = await import('../src/lib/db.js');

let counter = 0;

async function freshSweep({ discography, gapsByAlbum }) {
  counter += 1;
  const { mock } = await import('node:test');
  mock.reset();

  mock.module('../src/services/libraryDiscography.js', {
    namedExports: { getArtistDiscography: async () => discography },
  });

  mock.module('../src/services/libraryGaps.js', {
    namedExports: {
      detectAlbumGaps: async (mbid, { onMissing, signal }) => {
        const entry = gapsByAlbum[mbid];
        if (entry instanceof Error) throw entry;
        for (const track of entry ?? []) {
          if (signal?.aborted) break;
          onMissing?.(track);
        }
        return { album: {}, owned: [], missing: entry ?? [] };
      },
    },
  });

  return import(`../src/services/libraryArtistGaps.js?fresh=${counter}`);
}

function collect() {
  const events = [];
  return { events, onEvent: (event, data) => events.push([event, data]) };
}

test.after(() => setDbForTest(null));

test('walks every missing album and streams a result per missing track', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const { events, onEvent } = collect();

  const { sweepArtistMissing } = await freshSweep({
    discography: {
      unresolved: false,
      missing: [{ mbid: 'a1', title: 'First', year: 2000 }, { mbid: 'a2', title: 'Second', year: 2002 }],
    },
    gapsByAlbum: {
      a1: [{ position: 1, title: 'One' }, { position: 2, title: 'Two' }],
      a2: [{ position: 1, title: 'Three' }],
    },
  });
  const summary = await sweepArtistMissing('Band', { onEvent, db });

  assert.equal(summary.albums, 2);
  assert.equal(summary.missing, 3);
  const results = events.filter(([e]) => e === 'result');
  assert.equal(results.length, 3);
  // Each result carries the album it came from — the sweep spans many records,
  // so a bare track title wouldn't say which one.
  assert.equal(results[0][1].album, 'First');
  assert.equal(results[2][1].album, 'Second');
  db.close();
});

test('announces each album before working on it, with its place in the run', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const { events, onEvent } = collect();

  const { sweepArtistMissing } = await freshSweep({
    discography: {
      unresolved: false,
      missing: [{ mbid: 'a1', title: 'First' }, { mbid: 'a2', title: 'Second' }],
    },
    gapsByAlbum: { a1: [{ position: 1, title: 'One' }], a2: [] },
  });
  await sweepArtistMissing('Band', { onEvent, db });

  const albums = events.filter(([e]) => e === 'album').map(([, d]) => d);
  assert.deepEqual(albums.map((a) => a.albumIndex), [1, 2]);
  assert.deepEqual(albums.map((a) => a.albumCount), [2, 2]);
  // The announcement precedes that album's results, so the client can name what
  // it is waiting on rather than what it just finished.
  assert.equal(events[0][0], 'album');
  assert.equal(events[1][0], 'result');
  db.close();
});

test('one unreadable album is reported and stepped past', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const { events, onEvent } = collect();

  const broken = new Error('No release found for this release group');
  const { sweepArtistMissing } = await freshSweep({
    discography: {
      unresolved: false,
      missing: [{ mbid: 'a1', title: 'Broken' }, { mbid: 'a2', title: 'Fine' }],
    },
    gapsByAlbum: { a1: broken, a2: [{ position: 1, title: 'One' }] },
  });
  const summary = await sweepArtistMissing('Band', { onEvent, db });

  assert.deepEqual(events.filter(([e]) => e === 'album_error').map(([, d]) => d.title), ['Broken']);
  assert.equal(summary.missing, 1, 'the run continued to the next album');
  db.close();
});

// The next album would hit the same wall, and continuing would just deepen the
// rate limit — so this is the one error that ends the run.
test('a rate limit ends the whole sweep', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const { onEvent } = collect();

  const limited = Object.assign(new Error('YouTube is rate limiting'), { code: 'RATE_LIMITED' });
  const { sweepArtistMissing } = await freshSweep({
    discography: {
      unresolved: false,
      missing: [{ mbid: 'a1', title: 'First' }, { mbid: 'a2', title: 'Second' }],
    },
    gapsByAlbum: { a1: limited, a2: [{ position: 1, title: 'One' }] },
  });

  await assert.rejects(() => sweepArtistMissing('Band', { onEvent, db }), /rate limiting/i);
  db.close();
});

// A missing yt-dlp binary fails every album with the same message. Reporting
// that once per record is noise standing in for one clear failure.
test('a run of consecutive failures stops the sweep instead of repeating itself', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const { events, onEvent } = collect();

  const broken = new Error('yt-dlp is not installed or not on PATH');
  const { sweepArtistMissing } = await freshSweep({
    discography: {
      unresolved: false,
      missing: Array.from({ length: 8 }, (_, i) => ({ mbid: `a${i}`, title: `Album ${i}` })),
    },
    gapsByAlbum: Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`a${i}`, broken]),
    ),
  });

  await assert.rejects(() => sweepArtistMissing('Band', { onEvent, db }), /yt-dlp/i);
  assert.equal(
    events.filter(([e]) => e === 'album_error').length,
    3,
    'stopped after three in a row rather than reporting all eight',
  );
  db.close();
});

test('an isolated failure does not count towards the run that stops a sweep', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const { events, onEvent } = collect();

  const broken = new Error('No release found for this release group');
  // Failures alternate with successes, so the counter keeps resetting and every
  // album is attempted — one bad release group is not a broken run.
  const { sweepArtistMissing } = await freshSweep({
    discography: {
      unresolved: false,
      missing: Array.from({ length: 6 }, (_, i) => ({ mbid: `a${i}`, title: `Album ${i}` })),
    },
    gapsByAlbum: {
      a0: broken, a1: [{ position: 1, title: 'One' }],
      a2: broken, a3: [{ position: 1, title: 'Two' }],
      a4: broken, a5: [{ position: 1, title: 'Three' }],
    },
  });
  const summary = await sweepArtistMissing('Band', { onEvent, db });

  assert.equal(events.filter(([e]) => e === 'album_error').length, 3);
  assert.equal(summary.missing, 3, 'every album was still attempted');
  db.close();
});

test('an artist MusicBrainz cannot resolve reports that instead of sweeping', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const { events, onEvent } = collect();

  const { sweepArtistMissing } = await freshSweep({
    discography: { unresolved: true, missing: [] },
    gapsByAlbum: {},
  });
  const summary = await sweepArtistMissing('Band', { onEvent, db });

  assert.equal(summary.unresolved, true);
  assert.deepEqual(events, []);
  db.close();
});

test('an aborted sweep stops between albums', async () => {
  const db = openDb(':memory:');
  setDbForTest(db);
  const { events, onEvent } = collect();
  const ac = new AbortController();

  const { sweepArtistMissing } = await freshSweep({
    discography: {
      unresolved: false,
      missing: [{ mbid: 'a1', title: 'First' }, { mbid: 'a2', title: 'Second' }],
    },
    gapsByAlbum: { a1: [{ position: 1, title: 'One' }], a2: [{ position: 1, title: 'Two' }] },
  });

  // Abort as soon as the first album's first result lands.
  const summary = await sweepArtistMissing('Band', {
    db,
    signal: ac.signal,
    onEvent: (event, data) => {
      onEvent(event, data);
      if (event === 'result') ac.abort();
    },
  });

  assert.equal(events.filter(([e]) => e === 'album').length, 1, 'the second album was never started');
  assert.equal(summary.missing, 1);
  db.close();
});
