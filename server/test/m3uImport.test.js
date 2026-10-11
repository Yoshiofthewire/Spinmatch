import test from 'node:test';
import assert from 'node:assert/strict';
import { parseM3u, m3uItems } from '../src/services/m3uImport.js';
import { openDb } from '../src/lib/db.js';
import { upsertLocalTrack } from '../src/services/libraryRepo.js';

const ROOT = '/music';
const paths = (text, max = 5000) => parseM3u(text, ROOT, max).entries.map((e) => e.path);

test('absolute and MUSIC_DIR-relative paths resolve inside MUSIC_DIR', () => {
  assert.deepEqual(paths('/music/A/one.mp3\nA/two.mp3\n./A/../A/three.mp3'), [
    '/music/A/one.mp3', '/music/A/two.mp3', '/music/A/three.mp3',
  ]);
});

test('file:// URLs are percent-decoded; a host or encoded slash is no path', () => {
  assert.deepEqual(paths('file:///music/My%20Band/T%C3%BCr.flac\nfile://nas/music/x.mp3\nfile:///music/a%2Fb.mp3'), [
    '/music/My Band/Tür.flac', null, null,
  ]);
});

test('Windows backslashes become slashes', () => {
  assert.deepEqual(paths('A\\Album\\01.mp3'), ['/music/A/Album/01.mp3']);
});

test('traversal out of MUSIC_DIR is no path, not a lookup', () => {
  assert.deepEqual(paths('../etc/passwd\n/music/../etc/passwd\n..\\..\\x.mp3\n/musicx/a.mp3\n/etc/passwd'), [
    null, null, null, null, null,
  ]);
});

test('BOM and CRLF are handled; #EXTINF attaches to the next entry only; other # lines ignored', () => {
  const text = '﻿#EXTM3U\r\n#EXTINF:123,Portishead - Roads\r\n#EXTVLCOPT:x\r\nnowhere.mp3\r\nother.mp3\r\n';
  const { entries } = parseM3u(text, ROOT, 10);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].display, 'Portishead - Roads');
  assert.equal(entries[0].path, '/music/nowhere.mp3');
  assert.equal(entries[1].display, null);
});

test('entries past the cap are dropped and reported', () => {
  const lines = Array.from({ length: 5001 }, (_, i) => `t${i}.mp3`).join('\n');
  const capped = parseM3u(lines, ROOT, 5000);
  assert.equal(capped.entries.length, 5000);
  assert.equal(capped.truncated, true);
  assert.equal(parseM3u(lines, ROOT, 5001).truncated, false);
});

test('items: path hit uses its tags, else #EXTINF, else the file name (display only)', () => {
  const db = openDb(':memory:');
  upsertLocalTrack(db, {
    path: '/music/A/one.mp3', artist: 'Tagged', album: 'Al', title: 'One', durationMs: 1000, changeKey: '1',
  });
  const { entries } = parseM3u(
    '#EXTINF:1,Wrong - Name\n/music/A/one.mp3\n#EXTINF:-1,Band - Song\nmissing.mp3\n../../Artist - Stem.mp3',
    ROOT, 10,
  );
  assert.deepEqual(m3uItems(db, entries), [
    { artist: 'Tagged', title: 'One', album: 'Al', matchable: true },
    { artist: 'Band', title: 'Song', album: null, matchable: true },
    { artist: 'Artist', title: 'Stem', album: null, matchable: false },
  ]);
});
