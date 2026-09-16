import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlags, collectFlag } from '../src/args.js';

test('parseFlags parses --flag value pairs', () => {
  assert.deepEqual(
    parseFlags(['--type', 'characters', '--name', 'cecilia']),
    { type: 'characters', name: 'cecilia' });
});

test('parseFlags throws on a trailing flag with no value (the "undefined/" bug)', () => {
  assert.throws(() => parseFlags(['--type', 'characters', '--name']),
    /flag "--name" is missing a value/);
  // The whole point: a missing value must never silently become `undefined`.
  assert.throws(() => parseFlags(['--root']), /missing a value/);
});

test('parseFlags throws when a token is not a --flag', () => {
  assert.throws(() => parseFlags(['type', 'characters']), /expected --flag, got "type"/);
});

test('parseFlags handles an empty arg list', () => {
  assert.deepEqual(parseFlags([]), {});
});

test('collectFlag gathers every value for a repeatable flag', () => {
  const args = ['--image', 'a.png', '--image', 'b.png', '--model', 'm'];
  assert.deepEqual(collectFlag(args, 'image'), ['a.png', 'b.png']);
  assert.deepEqual(collectFlag(args, 'model'), ['m']);
  assert.deepEqual(collectFlag(args, 'video'), []);
});
