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

test('runBatch caps in-flight jobs at the concurrency limit', async () => {
  // Track how many jobs are submitted-but-not-yet-terminal at once; it must
  // never exceed the cap even with more requests than slots.
  let inFlight = 0;
  let peak = 0;
  const runner = {
    async generate() {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return { id: `job_${Math.random()}`, status: 'unknown', outputUrl: null };
    },
    async get(id) {
      inFlight -= 1; // this job is about to go terminal
      return { id, status: 'completed', outputUrl: `https://cdn/${id}.png` };
    },
  };
  const requests = Array.from({ length: 20 }, (_, i) => ({ ref: `r${i}`, model: 'm', opts: {} }));
  const results = await runBatch(runner, requests, { pollIntervalMs: 0, concurrency: 8 });
  assert.equal(results.length, 20);
  assert.ok(results.every((r) => r.status === 'completed'));
  assert.ok(peak <= 8, `expected at most 8 concurrent, saw ${peak}`);
});

test('runBatch preserves request order and isolates a single failure', async () => {
  // The 2nd job fails permanently; the rest must still complete, in order.
  const runner = {
    async generate(model, opts) {
      return { id: opts.prompt, status: 'unknown', outputUrl: null };
    },
    async get(id) {
      if (id === 'b') return { id, status: 'failed', outputUrl: null };
      return { id, status: 'completed', outputUrl: `https://cdn/${id}.png` };
    },
  };
  const results = await runBatch(runner, [
    { ref: 'a', model: 'm', opts: { prompt: 'a' } },
    { ref: 'b', model: 'm', opts: { prompt: 'b' } },
    { ref: 'c', model: 'm', opts: { prompt: 'c' } },
  ], { pollIntervalMs: 0, concurrency: 8 });
  assert.deepEqual(results.map((r) => r.ref), ['a', 'b', 'c']);
  assert.equal(results[0].status, 'completed');
  assert.equal(results[1].status, 'failed');
  assert.equal(results[2].status, 'completed');
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
