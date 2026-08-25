import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { recordCreditAttempt, collectLogEntries } from '../src/credits.js';
import { imageGenerationsLogPath } from '../src/paths.js';

test('image location logs to images/generations.jsonl and reconcile sees it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'creditimg-'));
  await recordCreditAttempt(root, { kind: 'image' }, {
    model: 'topaz_image', scale: 2, jobId: 'job-9', kind: 'upscale',
    credits: 3, creditsSource: 'api', status: 'generated',
    source: '/x/in.png', output: '/x/in.upscaled-2x-topaz_image.png',
  });
  const logged = JSON.parse((await readFile(imageGenerationsLogPath(root), 'utf8')).trim());
  assert.equal(logged.jobId, 'job-9');
  assert.equal(logged.kind, 'upscale');

  const entries = await collectLogEntries(root);
  assert.ok(entries.some((e) => e.jobId === 'job-9' && e.model === 'topaz_image'));
});
