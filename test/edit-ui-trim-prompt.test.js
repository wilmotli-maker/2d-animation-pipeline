// test/edit-ui-trim-prompt.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrimPrompt } from '../src/edit-ui/trim-prompt.js';

test('3kf prompt pins first, each pose at its offset, and last, scoping mouth to lip-sync', () => {
  const p = buildTrimPrompt({ dialogue: 'Hello there', clipDuration: 4, poses: [{ offset: 2 }], userPrompt: 'raise a fist' });
  assert.match(p, /@Video1/);
  assert.match(p, /"Hello there"/);
  assert.match(p, /@Image1 at 0\.0s/);
  assert.match(p, /@Image2 at 2\.0s/);
  assert.match(p, /@Image3 at 4\.0s/);
  assert.match(p, /BODY and EYES only/i);       // mouth keeps lip-syncing
  assert.match(p, /raise a fist/);              // user prompt folded in
});

test('text-pose prompt uses two stills and no middle pin', () => {
  const p = buildTrimPrompt({ dialogue: 'Hi', clipDuration: 4, poses: [], userPrompt: 'look surprised' });
  assert.match(p, /@Image1 at 0\.0s/);
  assert.match(p, /@Image2 at 4\.0s/);
  assert.doesNotMatch(p, /@Image3/);
  assert.match(p, /look surprised/);
});

test('empty dialogue still produces a valid prompt without an empty quote clause', () => {
  const p = buildTrimPrompt({ dialogue: '', clipDuration: 4, poses: [], userPrompt: '' });
  assert.doesNotMatch(p, /saying, ""/);
  assert.match(p, /@Image1 at 0\.0s/);
});
