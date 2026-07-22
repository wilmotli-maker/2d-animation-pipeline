import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJobId, parseJobResult } from '../src/jobresult.js';

test('parseJobId pulls a top-level id from JSON stdout', () => {
  const stdout = JSON.stringify({ id: 'job_abc123', status: 'queued' });
  assert.equal(parseJobId(stdout), 'job_abc123');
});

test('parseJobId falls back to a regex when stdout is not pure JSON', () => {
  const stdout = 'Submitted!\n{"id":"job_xyz","status":"queued"}\nDone.';
  assert.equal(parseJobId(stdout), 'job_xyz');
});

test('parseJobId returns null when no id is present', () => {
  assert.equal(parseJobId('nothing useful here'), null);
});

test('parseJobResult extracts id, status, and first output url', () => {
  const stdout = JSON.stringify({
    id: 'job_abc123',
    status: 'completed',
    results: [{ url: 'https://cdn.example/out.png' }],
  });
  const r = parseJobResult(stdout);
  assert.equal(r.id, 'job_abc123');
  assert.equal(r.status, 'completed');
  assert.equal(r.outputUrl, 'https://cdn.example/out.png');
});

test('parseJobResult tolerates missing output', () => {
  const r = parseJobResult(JSON.stringify({ id: 'j', status: 'queued' }));
  assert.equal(r.outputUrl, null);
});
