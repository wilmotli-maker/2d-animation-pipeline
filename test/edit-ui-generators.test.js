// test/edit-ui-generators.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGenerator, generatorNames } from '../src/edit-ui/generators.js';

test('resolveGenerator returns the stub generator by name', () => {
  const g = resolveGenerator('stub');
  assert.equal(g.name, 'stub');
  assert.equal(typeof g.run, 'function');
});

test('generatorNames lists stub among the registered backends', () => {
  assert.ok(generatorNames().includes('stub'));
});

test('resolveGenerator defaults to stub when no name is given', () => {
  assert.equal(resolveGenerator().name, 'stub');
  assert.equal(resolveGenerator(undefined).name, 'stub');
});

test('resolveGenerator throws a listing error for an unknown name', () => {
  assert.throws(() => resolveGenerator('nope'), (err) => {
    assert.match(err.message, /unknown generator "nope"/i);
    assert.match(err.message, /stub/); // lists the valid names
    return true;
  });
});
