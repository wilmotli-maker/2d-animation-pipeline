// test/studio-selection-sync.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSelectionSync } from '../src/studio/web/selection-sync.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setImmediate(r));

// A fake server whose request completion order the test controls. A PUT commits
// to `store` only when the test resolves it; a GET snapshots `store` when the
// test resolves it (or returns an explicit stale doc).
function fakeServer(initial = {}) {
  const store = structuredClone(initial);
  const gets = [], puts = [];
  const fetchJson = (url) => {
    const d = deferred();
    gets.push({
      url,
      respond: (doc) => d.resolve(doc ?? { version: 1, selected: structuredClone(store) }),
    });
    return d.promise;
  };
  const putJson = (url, body) => {
    const d = deferred();
    puts.push({
      url, body,
      ok: () => { if (body.versions.length) store[body.key] = [...body.versions].sort(); else delete store[body.key]; d.resolve({}); },
      fail: (msg = 'boom') => d.reject(new Error(msg)),
    });
    return d.promise;
  };
  return { store, gets, puts, fetchJson, putJson };
}

test('rescan during a pending save: load waits for it, later toggle keeps both (Cursor repro)', async () => {
  const srv = fakeServer({});
  const sync = createSelectionSync(srv);
  const t1 = sync.toggle('shot-1', 'v001', true);          // PUT pending
  assert.ok(sync.has('shot-1::v001'));
  const loading = sync.load();                              // Rescan clicked
  await tick();
  assert.equal(srv.gets.length, 0, 'GET must wait for the pending PUT');
  srv.puts[0].ok();                                         // PUT commits
  assert.deepEqual(await t1, { ok: true, reverted: false });
  await tick();
  assert.equal(srv.gets.length, 1);
  srv.gets[0].respond();                                    // snapshot taken after the commit
  await loading;
  assert.ok(sync.has('shot-1::v001'), 'reload must not drop the committed toggle');
  const t2 = sync.toggle('shot-1', 'v002', true);
  await tick();
  assert.deepEqual(srv.puts[1].body, { key: 'shot-1', versions: ['v001', 'v002'] });
  srv.puts[1].ok();
  await t2;
  assert.deepEqual(srv.store, { 'shot-1': ['v001', 'v002'] });
  assert.deepEqual([...sync.selected].sort(), ['shot-1::v001', 'shot-1::v002']);
});

test('a GET issued before the PUT commits (stale {}) still cannot drop a toggle made during it', async () => {
  const srv = fakeServer({});
  const sync = createSelectionSync(srv);
  const loading = sync.load();                              // nothing pending: GET goes out now
  await tick();
  assert.equal(srv.gets.length, 1);
  const t1 = sync.toggle('shot-1', 'v001', true);           // clicked while the GET is in flight
  srv.gets[0].respond({ version: 1, selected: {} });        // old snapshot
  await loading;
  assert.ok(sync.has('shot-1::v001'));
  await tick();
  srv.puts[0].ok();
  await t1;
  const t2 = sync.toggle('shot-1', 'v002', true);
  await tick();
  srv.puts[1].ok();
  await t2;
  assert.deepEqual(srv.store, { 'shot-1': ['v001', 'v002'] });
});

test('toggle during an in-flight GET keeps the client versions for that key only', async () => {
  const srv = fakeServer({});
  const sync = createSelectionSync(srv);
  const loading = sync.load();
  await tick();
  sync.toggle('a', 'v002', true);
  // Server has other data (e.g. another tab): untouched keys take it, the toggled key keeps the client's.
  srv.gets[0].respond({ version: 1, selected: { a: ['v001'], b: ['v003'] } });
  await loading;
  assert.deepEqual([...sync.selected].sort(), ['a::v002', 'b::v003']);
  assert.equal(srv.puts.length, 1);
  assert.deepEqual(srv.puts[0].body, { key: 'a', versions: ['v002'] });
});

test('load without pending work takes the server snapshot and drops stale local keys', async () => {
  const srv = fakeServer({ a: ['v001'] });
  const sync = createSelectionSync(srv);
  let p = sync.load(); await tick(); srv.gets[0].respond(); await p;
  assert.deepEqual([...sync.selected], ['a::v001']);
  const sel = sync.selected;
  srv.store.a = ['v002'];
  p = sync.load(); await tick(); srv.gets[1].respond(); await p;
  assert.equal(sync.selected, sel, 'set is mutated in place');
  assert.deepEqual([...sync.selected], ['a::v002']);
  assert.equal(sync.size, 1);
});

test('failed save reverts only when no later toggle of the same box happened', async () => {
  const srv = fakeServer({});
  const sync = createSelectionSync(srv);
  const r1 = sync.toggle('a', 'v001', true);
  await tick();
  srv.puts[0].fail('disk full');
  const res = await r1;
  assert.equal(res.ok, false);
  assert.equal(res.reverted, true);
  assert.equal(res.error.message, 'disk full');
  assert.equal(sync.has('a::v001'), false);

  const c1 = sync.toggle('a', 'v001', true);
  const c2 = sync.toggle('a', 'v001', false);               // later click owns the box
  await tick();
  srv.puts[1].fail();
  assert.deepEqual({ ...(await c1), error: undefined }, { ok: false, reverted: false, error: undefined });
  assert.equal(sync.has('a::v001'), false, 'not reverted to checked');
  await tick();
  srv.puts[2].ok();
  assert.deepEqual(await c2, { ok: true, reverted: false });
});

test('concurrent toggles on one key serialize; the last PUT carries the final set', async () => {
  const srv = fakeServer({});
  const sync = createSelectionSync(srv);
  const a = sync.toggle('k', 'v001', true);
  const b = sync.toggle('k', 'v002', true);
  const c = sync.toggle('k', 'v003', true);
  sync.toggle('other', 'v001', true);                       // other keys are not blocked
  await tick();
  assert.deepEqual(srv.puts.map((p) => p.body.key), ['k', 'other']);
  srv.puts[0].ok(); await a; await tick();
  assert.equal(srv.puts.length, 3);
  srv.puts[2].ok(); await b; await tick();
  assert.equal(srv.puts.length, 4);
  assert.deepEqual(srv.puts[3].body, { key: 'k', versions: ['v001', 'v002', 'v003'] });
  srv.puts[3].ok(); await c;
  assert.deepEqual(srv.store.k, ['v001', 'v002', 'v003']);
  assert.deepEqual(sync.versionsFor('k'), ['v001', 'v002', 'v003']);
});

test('flush waits for saves queued while flushing', async () => {
  const srv = fakeServer({});
  const sync = createSelectionSync(srv);
  sync.toggle('a', 'v001', true);
  let done = false;
  const f = sync.flush().then(() => { done = true; });
  await tick();
  sync.toggle('b', 'v001', true);
  srv.puts[0].ok();
  await tick();
  assert.equal(done, false);
  srv.puts[1].ok();
  await f;
  assert.equal(done, true);
});
