// test/edit-ui-runview.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readRunView } from '../src/edit-ui/runview.js';

const WS = '/ws';
// A manifest shaped like workspace.createRun + inputs.prepareRunInputs produce.
function manifest(extra = {}) {
  return {
    run: 'v001',
    kind: 'video',
    prompt: { file: 'prompt.txt', text: 'make it wave' },
    settings: { fps: 24 },
    source: { duration: 10, width: 1080, height: 1920 },
    window: { start: 0, end: 10 },
    inputs: [
      { role: 'source', path: 'id/source.mp4' },
      { role: 'audio', path: 'id/derived/audio.wav' },
      { role: 'prompt', path: 'id/runs/v001/prompt.txt' },
      { role: 'speechref', path: 'id/runs/v001/speechref.mp4', window: { start: 0, end: 10 } },
      { role: 'keyframe', kind: 'auto', frame: 0, path: 'id/runs/v001/keyframes/auto/f0000.png' },
      { role: 'keyframe', kind: 'edited', frame: 12, path: 'id/runs/v001/keyframes/edited/f0012.png' },
      { role: 'annotation', kind: 'frame', frame: 12, path: 'id/runs/v001/annotations/f0012.png' },
      { role: 'annotation', kind: 'strokes', frame: 12, path: 'id/runs/v001/annotations/f0012-strokes.png' },
    ],
    ...extra,
  };
}

test('resolves scalar roles to absolute paths', () => {
  const v = readRunView(WS, manifest());
  assert.equal(v.prompt, 'make it wave');
  assert.equal(v.source, path.join(WS, 'id/source.mp4'));
  assert.equal(v.audio, path.join(WS, 'id/derived/audio.wav'));
  assert.equal(v.speechref, path.join(WS, 'id/runs/v001/speechref.mp4'));
  assert.deepEqual(v.window, { start: 0, end: 10 });
});

test('images are ordered edited keyframe, then annotation frame, then auto keyframe; strokes excluded', () => {
  const v = readRunView(WS, manifest());
  assert.deepEqual(v.images.map((i) => path.basename(i.path)), ['f0012.png', 'f0012.png', 'f0000.png']);
  assert.deepEqual(v.images.map((i) => `${i.role}:${i.kind}`), ['keyframe:edited', 'annotation:frame', 'keyframe:auto']);
  assert.ok(v.images.every((i) => path.isAbsolute(i.path)));
});

test('maxImages caps the list and records the rest in dropped, keeping highest priority', () => {
  const v = readRunView(WS, manifest(), { maxImages: 2 });
  assert.equal(v.images.length, 2);
  assert.deepEqual(v.images.map((i) => `${i.role}:${i.kind}`), ['keyframe:edited', 'annotation:frame']);
  assert.equal(v.dropped.length, 1);
  assert.equal(`${v.dropped[0].role}:${v.dropped[0].kind}`, 'keyframe:auto');
});

test('missing optional roles are null and dropped is empty under the cap', () => {
  const v = readRunView(WS, { prompt: { text: '' }, inputs: [{ role: 'source', path: 'id/source.mp4' }] });
  assert.equal(v.audio, null);
  assert.equal(v.speechref, null);
  assert.deepEqual(v.images, []);
  assert.deepEqual(v.dropped, []);
  assert.equal(v.window, null);
});
