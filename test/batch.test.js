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
