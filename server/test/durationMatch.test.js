import test from 'node:test';
import assert from 'node:assert/strict';
import { rankCandidates, pickResult } from '../src/services/durationMatch.js';

test('rankCandidates sorts by closeness and flags tolerance (<=5s)', () => {
  const target = 200000;
  const ranked = rankCandidates(
    [
      { id: 'far', durationMs: 220000 },
      { id: 'exact', durationMs: 200000 },
      { id: 'close', durationMs: 203000 },
    ],
    target
  );

  assert.deepEqual(
    ranked.map((c) => c.id),
    ['exact', 'close', 'far']
  );
  assert.equal(ranked[0].deltaSeconds, 0);
  assert.equal(ranked[0].withinTolerance, true);
  assert.equal(ranked[1].deltaSeconds, 3);
  assert.equal(ranked[1].withinTolerance, true);
  assert.equal(ranked[2].deltaSeconds, 20);
  assert.equal(ranked[2].withinTolerance, false);
});

test('exactly 5s delta counts as within tolerance (boundary inclusive)', () => {
  const ranked = rankCandidates([{ id: 'boundary', durationMs: 205000 }], 200000);
  assert.equal(ranked[0].deltaSeconds, 5);
  assert.equal(ranked[0].withinTolerance, true);
});

test('6s delta is outside tolerance', () => {
  const ranked = rankCandidates([{ id: 'over', durationMs: 206000 }], 200000);
  assert.equal(ranked[0].deltaSeconds, 6);
  assert.equal(ranked[0].withinTolerance, false);
});

test('a tie between two equal deltas keeps the first input order', () => {
  const ranked = rankCandidates(
    [
      { id: 'a', durationMs: 195000 },
      { id: 'b', durationMs: 205000 },
    ],
    200000
  );
  assert.deepEqual(ranked.map((c) => c.id), ['a', 'b']);
});

test('pickResult returns confirmed for the closest candidate within tolerance', () => {
  const ranked = rankCandidates(
    [
      { id: 'a', title: 'A', durationMs: 220000 },
      { id: 'b', title: 'B', durationMs: 201000 },
    ],
    200000
  );
  const result = pickResult(ranked);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.video.id, 'b');
  assert.equal(result.deltaSeconds, 1);
});

test('pickResult returns unverified with the closest candidate when none are within tolerance', () => {
  const ranked = rankCandidates([{ id: 'a', title: 'A', durationMs: 260000 }], 200000);
  const result = pickResult(ranked);
  assert.equal(result.status, 'unverified');
  assert.equal(result.video.id, 'a');
});

test('pickResult returns no_results for an empty candidate list', () => {
  const result = pickResult([]);
  assert.equal(result.status, 'no_results');
  assert.equal(result.video, null);
});
