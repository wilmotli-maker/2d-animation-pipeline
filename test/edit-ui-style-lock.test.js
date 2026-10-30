import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStyleLock, matchSavedElement, elementOptionValue, elementSelectionAfterList } from '../src/edit-ui/web/style-lock.js';

test('non-empty free text replaces the loaded object, including after trim', () => {
  const loaded = { styleRegister: 'flat-cartoon' };
  assert.equal(resolveStyleLock({ freeText: '  a red dragon  ', loaded }), 'a red dragon');
  assert.equal(resolveStyleLock({ freeText: '   ', loaded }), loaded);
  assert.equal(resolveStyleLock({ freeText: '', loaded: null }), '');
  assert.equal(resolveStyleLock({ freeText: '', loaded }), loaded);
});

test('a saved element is kept only when that type and name are still listed', () => {
  const elements = [{ type: 'characters', name: 'ada' }];
  assert.deepEqual(matchSavedElement(elements, { type: 'characters', name: 'ada' }), elements[0]);
  assert.equal(matchSavedElement(elements, { type: 'characters', name: 'gone' }), null);
  assert.equal(matchSavedElement(elements, null), null);
  assert.equal(elementOptionValue(elements[0]), 'characters/ada');
});

test('a failed element list keeps the saved selection', () => {
  const saved = { type: 'characters', name: 'ada' };
  assert.deepEqual(elementSelectionAfterList(saved, [], { listed: false }), saved);
  assert.equal(elementSelectionAfterList(saved, [], { listed: true }), null);
  assert.deepEqual(elementSelectionAfterList(saved, [saved], { listed: true }), saved);
});
