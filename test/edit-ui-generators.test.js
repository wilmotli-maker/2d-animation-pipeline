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

test('fal is the default; hf and the seedance-draft alias resolve to the hf backend', () => {
  for (const n of ['muapi', 'fal', 'hf', 'seedance-draft', 'stub']) assert.ok(generatorNames().includes(n));
  assert.equal(resolveGenerator().name, 'fal');             // default
  assert.equal(resolveGenerator(undefined).name, 'fal');
  assert.equal(resolveGenerator('fal').name, 'fal');
  assert.equal(resolveGenerator('muapi').name, 'muapi');
  assert.equal(resolveGenerator('hf').name, 'hf');
  assert.equal(resolveGenerator('seedance-draft').name, 'hf'); // back-compat alias
});

test('stub is still selectable by name', () => {
  assert.equal(resolveGenerator('stub').name, 'stub');
});

test('resolveGenerator throws a listing error for an unknown name', () => {
  assert.throws(() => resolveGenerator('nope'), (err) => {
    assert.match(err.message, /unknown generator "nope"/i);
    assert.match(err.message, /stub/); // lists the valid names
    return true;
  });
});
