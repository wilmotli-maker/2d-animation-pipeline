import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createElement, writeStyleLock } from '../src/element.js';

test('pipeline edit-ui serves elements from --root', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'edit-ui-cli-'));
  const root = path.join(out, 'project');
  const workspace = path.join(out, 'ws');
  await createElement(root, { type: 'characters', name: 'ada' });
  await writeStyleLock(root, 'characters', 'ada', { wardrobe: 'red hoodie' });
  const child = spawn(process.execPath, [
    path.join(import.meta.dirname, '..', 'bin', 'pipeline.js'),
    'edit-ui', '--generator', 'stub', '--port', '0',
    '--root', root, '--workspace', workspace,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`edit-ui did not print a url:\n${log}`)), 20000);
    const onData = (buf) => {
      log += buf;
      const m = log.match(/edit-ui: (http:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`edit-ui exited ${code}:\n${log}`)); });
  }).finally(() => {});
  try {
    assert.match(log, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const list = await (await fetch(`${url}api/elements`)).json();
    assert.deepEqual(list.elements, [{ type: 'characters', name: 'ada' }]);
    const lock = await (await fetch(`${url}api/elements/characters/ada/style-lock`)).json();
    assert.equal(lock.styleLock.wardrobe, 'red hoodie');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.on('exit', resolve));
    await rm(out, { recursive: true, force: true });
  }
});
