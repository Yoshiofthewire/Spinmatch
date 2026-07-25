// Splitting joined artist credits. Every case here came from a real 1000-artist
// library or from checking what MusicBrainz actually returns — the band names in
// the "does not split" group are the ones that would be silently corrupted by a
// naive splitter.
import test from 'node:test';
import assert from 'node:assert/strict';

const { primaryArtist, isJoinedCredit } = await import('../src/lib/artistCredit.js');

test('splits on the reliable credit joiners', () => {
  const cases = [
    ['Grabbitz feat. REZZ', 'Grabbitz'],
    ['Sole ft. Pabzzz & Santé', 'Sole'],
    ['Some Artist featuring Another', 'Some Artist'],
    ['Nine Inch Nails / Stephen Morris and Gillian Gilbert', 'Nine Inch Nails'],
    ['Artist A vs. Artist B', 'Artist A'],
    ['Paul Simon with Urubamba', 'Paul Simon'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(primaryArtist(input), expected, input);
  }
});

test('splits on the riskier joiners too — the owned check is what makes that safe', () => {
  const cases = [
    ['Justice & Thundercat', 'Justice'],
    ['Kristen Bell & Idina Menzel', 'Kristen Bell'],
    ['Dave Matthews & Tim Reynolds', 'Dave Matthews'],
    ['Jim Morrison, music by The Doors', 'Jim Morrison'],
    ['Jim Broadbent, Richard Roxburgh and Anthony Weigh', 'Jim Broadbent'],
    ['Pieter Schlosser, Skye Lewin, Michael Salvatori', 'Pieter Schlosser'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(primaryArtist(input), expected, input);
  }
});

test('a reliable joiner wins over a riskier one later in the string', () => {
  // "A feat. B & C" must yield "A", not "A feat. B".
  assert.equal(primaryArtist('梅とら feat. 巡音ルカ、初音ミク＆MAYU'), '梅とら');
  assert.equal(primaryArtist('Artist feat. Guest & Other'), 'Artist');
});

test('handles full-width separators', () => {
  assert.equal(primaryArtist('アーティスト／ゲスト'), 'アーティスト');
  assert.equal(primaryArtist('歌手、ゲスト'), '歌手');
});

// The whole reason the split is a fallback rather than a rewrite. These names
// resolve whole against MusicBrainz, so in the real flow the splitter is never
// reached for them — but if it ever is, it must not silently mangle them into
// something that happens to match an unrelated artist.
test('returns a segment for band names containing "&" — which is why ordering and the owned check matter', () => {
  // These DO split; the protection is that they resolve whole first, and that
  // the segment must be separately owned. Pinned so the risk stays visible.
  assert.equal(primaryArtist('She & Him'), 'She');
  assert.equal(primaryArtist('Earth, Wind & Fire'), 'Earth');
  assert.equal(primaryArtist('Hall & Oates'), 'Hall');
});

test('returns null when there is no joiner to split on', () => {
  for (const name of ['Radiohead', 'The Beatles', 'Nine Inch Nails', 'Godspeed You! Black Emperor']) {
    assert.equal(primaryArtist(name), null, name);
  }
});

test('does not split a name whose "and" is part of the band name', () => {
  // Bare " and " is deliberately not a joiner: too many real names contain it,
  // and the real multi-credit cases put a comma before it anyway.
  assert.equal(primaryArtist('Belle and Sebastian'), null);
  assert.equal(primaryArtist('Nick Cave and the Bad Seeds'), null);
  assert.equal(primaryArtist('Florence and the Machine'), null);
});

test('empty, blank and non-string input yield null rather than throwing', () => {
  for (const value of ['', '   ', null, undefined]) {
    assert.equal(primaryArtist(value), null, String(value));
  }
});

test('a segment too short to be a name is rejected', () => {
  assert.equal(primaryArtist('X & Some Band'), null);
});

test('isJoinedCredit agrees with whether a split is available', () => {
  assert.equal(isJoinedCredit('Justice & Thundercat'), true);
  assert.equal(isJoinedCredit('Radiohead'), false);
});
