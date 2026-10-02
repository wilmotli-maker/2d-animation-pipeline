// src/studio/web/selection-sync.js
// Client-side selection state and its sync with /api/selections. No DOM access,
// so node:test can drive it with fake transports.
//
// `selected` holds `key::version` strings and is mutated in place (never
// replaced), so callers may keep a reference to it.

const API = '/api/selections';

export function createSelectionSync({ fetchJson, putJson }) {
  const selected = new Set();
  // key -> tail of that key's save chain. Each link never rejects, so a failed
  // save doesn't poison the next one and flush() can simply await them.
  const chains = new Map();
  // key -> toggles so far (any version). load() compares these across its GET.
  const keyGen = new Map();
  // key::version -> toggles so far. A failed save only reverts its own click if
  // no later toggle of the same box has happened since; otherwise that later
  // click owns the state (and its queued save reads versionsFor at send time).
  const toggleGen = new Map();

  function versionsFor(key) {
    const p = `${key}::`;
    return [...selected].filter((k) => k.startsWith(p)).map((k) => k.slice(p.length));
  }

  // Optimistic: `selected` changes synchronously, before the returned promise
  // settles. Saves are chained per key so PUTs land in click order, and each
  // sends the list as of send time; otherwise a stale list from an earlier
  // click could win. Resolves to { ok, reverted, error }; never rejects.
  function toggle(key, version, want) {
    const k = `${key}::${version}`;
    const gen = (toggleGen.get(k) || 0) + 1;
    toggleGen.set(k, gen);
    keyGen.set(key, (keyGen.get(key) || 0) + 1);
    if (want) selected.add(k); else selected.delete(k);
    const op = (chains.get(key) || Promise.resolve())
      .then(() => putJson(API, { key, versions: versionsFor(key) }))
      .then(() => ({ ok: true, reverted: false }), (error) => {
        const reverted = toggleGen.get(k) === gen;
        if (reverted) { if (want) selected.delete(k); else selected.add(k); }
        return { ok: false, reverted, error };
      });
    chains.set(key, op);
    op.then(() => { if (chains.get(key) === op) chains.delete(key); });
    return op;
  }

  // Wait until no save is pending, including saves queued while waiting.
  async function flush() {
    for (;;) {
      const pending = [...chains.values()];
      if (!pending.length) return;
      await Promise.all(pending);
    }
  }

  // Reload from the server without clobbering newer local state:
  //  1. flush() first, so every save clicked so far has committed (or failed and
  //     reverted) before the GET is issued and the snapshot can include it;
  //  2. for any key toggled while the GET was in flight, the snapshot may predate
  //     that toggle's PUT, so keep the client's versions for that key; the toggle
  //     itself queued the save that will persist them;
  //  3. every other key takes the server snapshot.
  async function load() {
    await flush();
    const before = new Map(keyGen);
    const doc = await fetchJson(API);
    const changed = (key) => (keyGen.get(key) || 0) !== (before.get(key) || 0);
    const next = [];
    for (const k of selected) if (changed(k.slice(0, k.lastIndexOf('::')))) next.push(k);
    for (const [key, vs] of Object.entries(doc.selected)) {
      if (!changed(key)) for (const v of vs) next.push(`${key}::${v}`);
    }
    selected.clear();
    for (const k of next) selected.add(k);
    return doc;
  }

  return {
    selected, load, toggle, versionsFor, flush,
    has: (k) => selected.has(k),
    get size() { return selected.size; },
  };
}
