import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJobId, parseJobResult } from '../src/jobresult.js';

test('parseJobId pulls a top-level id from JSON stdout', () => {
  const stdout = JSON.stringify({ id: 'job_abc123', status: 'queued' });
  assert.equal(parseJobId(stdout), 'job_abc123');
});

test('parseJobId reads a JSON object embedded among log lines', () => {
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

test('parseJobId prefers the final result line over earlier progress lines', () => {
  const stdout = '{"event":"progress","id":"tmp_1"}\n{"id":"job_real","status":"completed"}';
  assert.equal(parseJobId(stdout), 'job_real');
});

test('parseJobId coerces a numeric id to string', () => {
  assert.equal(parseJobId('{"id":12345,"status":"queued"}'), '12345');
});

test('parseJobResult reads the final result line in streamed output', () => {
  const stdout =
    '{"event":"progress","id":"tmp_1"}\n' +
    '{"id":"job_real","status":"completed","results":[{"url":"https://x/out.png"}]}';
  const r = parseJobResult(stdout);
  assert.equal(r.id, 'job_real');
  assert.equal(r.status, 'completed');
  assert.equal(r.outputUrl, 'https://x/out.png');
});
