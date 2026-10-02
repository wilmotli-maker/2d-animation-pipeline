// test/studio-media.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveWithin, contentType, parseRange } from '../src/studio/media.js';

test('resolveWithin: accepts nested paths, rejects escapes', () => {
  const base = path.resolve('/proj');
  assert.equal(resolveWithin(base, 'shots/a/drafts/v001/output.mp4'), path.join(base, 'shots/a/drafts/v001/output.mp4'));
  assert.equal(resolveWithin(base, '../etc/passwd'), null);
  assert.equal(resolveWithin(base, 'shots/../../etc/passwd'), null);
  assert.equal(resolveWithin(base, '/etc/passwd'), null);
  assert.equal(resolveWithin(base, ''), null);
  assert.equal(resolveWithin(base, 'a\0b'), null);
  assert.equal(resolveWithin(base, '..foo/x.png'), path.join(base, '..foo/x.png'));
});

test('contentType: known media + fallback', () => {
  assert.equal(contentType('a.mp4'), 'video/mp4');
  assert.equal(contentType('a.WEBM'), 'video/webm');
  assert.equal(contentType('a.mov'), 'video/quicktime');
  assert.equal(contentType('a.png'), 'image/png');
  assert.equal(contentType('a.js'), 'text/javascript; charset=utf-8');
  assert.equal(contentType('a.bin'), 'application/octet-stream');
});

test('parseRange: start-end, open-ended, suffix, invalid', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=0-5000', 1000), { start: 0, end: 999 });
  assert.equal(parseRange(undefined, 1000), null);          // no header -> full body
  assert.equal(parseRange('bytes=2000-', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=5-1', 1000), 'unsatisfiable');
  assert.equal(parseRange('items=0-1', 1000), null);        // unknown unit -> ignore, send full
});
