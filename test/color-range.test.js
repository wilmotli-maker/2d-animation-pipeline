import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLOR_RANGE, RANGE_ARGS } from '../src/color-range.js';
import { trimArgs } from '../src/edit-ui/trim-media.js';
import { segmentRenderArgs } from '../src/edit-ui/splice.js';

// Assert that -color_range tv sits immediately after -pix_fmt yuv420p (the swscale flags it governs).
function assertRangeAfterPixFmt(args) {
  const i = args.indexOf('-pix_fmt');
  assert.ok(i >= 0, 'has -pix_fmt');
  assert.equal(args[i + 1], 'yuv420p');
  assert.equal(args[i + 2], '-color_range');
  assert.equal(args[i + 3], COLOR_RANGE);
}

test('the pipeline standardizes on limited/tv range', () => {
  assert.equal(COLOR_RANGE, 'tv');
  assert.deepEqual(RANGE_ARGS, ['-color_range', 'tv']);
});

test('trimArgs tags the range on the trimmed window', () => {
  const args = trimArgs({ input: 'in.mp4', output: 'out.mp4', start: 1, span: 2 });
  assertRangeAfterPixFmt(args);
  assert.equal(args[args.length - 1], 'out.mp4'); // the tag stays before the output file
});

test('trimArgs tags the range with audio + padding too', () => {
  const args = trimArgs({ input: 'in.mp4', output: 'out.mp4', start: 0, span: 3, padStart: 0.5, audio: true });
  assertRangeAfterPixFmt(args);
});

test('segmentRenderArgs tags the range on each spliced segment', () => {
  const args = segmentRenderArgs({ src: 'orig', from: 0, to: 24 }, { orig: 'o.mp4', gen: 'g.mp4', fps: 24, out: 's.mp4' });
  assertRangeAfterPixFmt(args);
  assert.equal(args[args.length - 1], 's.mp4');
});
