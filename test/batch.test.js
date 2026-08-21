import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTerminalStatus, runBatch } from '../src/batch.js';

test('isTerminalStatus recognizes completion and failure, not in-progress', () => {
  assert.equal(isTerminalStatus('completed'), true);
  assert.equal(isTerminalStatus('failed'), true);
  assert.equal(isTerminalStatus('error'), true);
  assert.equal(isTerminalStatus('canceled'), true);
  assert.equal(isTerminalStatus('queued'), false);
  assert.equal(isTerminalStatus('in_progress'), false);
  assert.equal(isTerminalStatus('unknown'), false);
});

test('isTerminalStatus treats moderation verdicts as terminal failures', () => {
  // These end a job permanently but were previously unrecognized, causing the
  // poller to spin until maxPolls (~1h).
  assert.equal(isTerminalStatus('nsfw'), true);
  assert.equal(isTerminalStatus('moderated'), true);
  assert.equal(isTerminalStatus('content_moderation'), true);
  assert.equal(isTerminalStatus('rejected'), true);
});

// A fake runner: generate() hands back a submitted id; get() returns 'queued'
// once then 'completed', so the poller must loop at least once.
function fakeRunner() {
  const getCalls = {};
  return {
    generated: [],
    async generate(model, opts) {
      this.generated.push({ model, opts });
      return { id: `job_${this.generated.length}`, status: 'unknown', outputUrl: null };
    },
    async get(id) {
      getCalls[id] = (getCalls[id] || 0) + 1;
      const done = getCalls[id] >= 2;
      return {
        id,
        status: done ? 'completed' : 'queued',
        outputUrl: done ? `https://cdn/${id}.png` : null,
      };
    },
  };
}

test('runBatch submits every request without waiting, then polls to completion', async () => {
  const runner = fakeRunner();
  const requests = [
    { ref: 'a', model: 'nano_banana', opts: { prompt: 'x' } },
    { ref: 'b', model: 'nano_banana', opts: { prompt: 'y' } },
  ];
  const results = await runBatch(runner, requests, { pollIntervalMs: 0 });

  // Submitted async (wait:false) before any polling.
  assert.equal(runner.generated.length, 2);
  assert.equal(runner.generated[0].opts.wait, false);

  assert.equal(results.length, 2);
  assert.equal(results[0].ref, 'a');
  assert.equal(results[0].id, 'job_1');
  assert.equal(results[0].status, 'completed');
  assert.equal(results[0].outputUrl, 'https://cdn/job_1.png');
});

test('runBatch surfaces a submit that returned no id as an error result', async () => {
  const runner = {
    async generate() { return { id: null, status: 'unknown', outputUrl: null }; },
    async get() { throw new Error('should not be polled'); },
  };
  const results = await runBatch(runner, [{ ref: 'a', model: 'm', opts: {} }], { pollIntervalMs: 0 });
  assert.equal(results[0].status, 'error');
  assert.match(results[0].error, /no job id/i);
});

test('runBatch tolerates transient get() throws and still completes the job', async () => {
  // The higgsfield CLI intermittently errors on `generate get`; a single thrown
  // get must NOT permanently fail an otherwise-healthy job.
  let calls = 0;
  const runner = {
    async generate() { return { id: 'job_1', status: 'unknown', outputUrl: null }; },
    async get(id) {
      calls += 1;
      if (calls <= 2) throw new Error('empty response from CLI'); // two transient blips
      return { id, status: 'completed', outputUrl: `https://cdn/${id}.png` };
    },
  };
  const results = await runBatch(runner, [{ ref: 'a', model: 'm', opts: {} }],
    { pollIntervalMs: 0 });
  assert.equal(results[0].status, 'completed');
  assert.equal(results[0].outputUrl, 'https://cdn/job_1.png');
  assert.equal(results[0].error, undefined, 'recovered job carries no stale error');
});

test('runBatch gives up after maxGetErrors consecutive get() throws', async () => {
  const runner = {
    async generate() { return { id: 'job_1', status: 'unknown', outputUrl: null }; },
    async get() { throw new Error('persistent CLI failure'); },
  };
  const results = await runBatch(runner, [{ ref: 'a', model: 'm', opts: {} }],
    { pollIntervalMs: 0, maxGetErrors: 3 });
  assert.equal(results[0].status, 'error');
  assert.match(results[0].error, /3x consecutively/);
});

test('runBatch does not orphan a job when two submits return the same id', async () => {
  let gen = 0;
  const runner = {
    async generate() { gen += 1; return { id: 'dup', status: 'unknown', outputUrl: null }; },
    async get(id) { return { id, status: 'completed', outputUrl: `https://cdn/${id}.png` }; },
  };
  const results = await runBatch(runner, [
    { ref: 'a', model: 'm', opts: {} },
    { ref: 'b', model: 'm', opts: {} },
  ], { pollIntervalMs: 0 });
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.status === 'completed'),
    'both jobs should complete even with a shared id');
});
