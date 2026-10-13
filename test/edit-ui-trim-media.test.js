// test/edit-ui-trim-media.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trimArgs, trimPadVideo, trimPadSpeech, extractFrame } from '../src/edit-ui/trim-media.js';

test('trimArgs seeks, limits span, and pads a silent-video clip at both ends', () => {
  const args = trimArgs({ input: 'in.mp4', output: 'out.mp4', start: 7, span: 3, padStart: 0, padEnd: 1, video: true, audio: false });
  const s = args.join(' ');
  assert.match(s, /-ss 7\.000/);
  assert.match(s, /-t 3\.000/);
  assert.match(s, /-an/);
  assert.match(s, /tpad=.*stop_duration=1/); // tail pad 1s
  assert.match(s, /-c:v libx264/);
  assert.match(s, /out\.mp4$/);
});

test('trimArgs head-pads video and pads audio with silence for a speech clip', () => {
  const args = trimArgs({ input: 'sr.mp4', output: 'srt.mp4', start: 0, span: 3, padStart: 1, padEnd: 0, video: true, audio: true });
  const s = args.join(' ');
  assert.match(s, /tpad=start_duration=1/);     // head video pad
  assert.match(s, /adelay=1000/);               // 1s audio delay (head silence), ms
  assert.doesNotMatch(s, /-an/);
  assert.match(s, /-c:a aac/);
});

test('trimPadVideo invokes ffmpeg once with the built args', async () => {
  const calls = [];
  await trimPadVideo(async (a) => calls.push(a), { input: 'in.mp4', output: 'o.mp4', sourceSpan: [3, 7], pad: { start: 0, end: 0 } });
  assert.equal(calls.length, 1);
  assert.match(calls[0].join(' '), /-ss 3\.000.*-t 4\.000/);
});

test('trimPadSpeech builds an audio-bearing padded clip', async () => {
  const calls = [];
  await trimPadSpeech(async (a) => calls.push(a), { input: 'sr.mp4', output: 'o.mp4', sourceSpan: [0, 3], pad: { start: 1, end: 0 } });
  assert.match(calls[0].join(' '), /adelay=1000/);
});

test('extractFrame grabs a single frame at a time', async () => {
  const calls = [];
  await extractFrame(async (a) => calls.push(a), { input: 'o.mp4', time: 0, output: 'first.png' });
  assert.match(calls[0].join(' '), /-ss 0\.000 -i o\.mp4 -frames:v 1 first\.png/);
});
