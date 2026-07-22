#!/usr/bin/env node
import { REPO_ROOT } from '../src/config.js';
import { createElement } from '../src/element.js';
import { createShot, newDraft, promoteDraft } from '../src/shot.js';

const [, , cmd, sub, ...rest] = process.argv;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// Minimal --key value parser for the leaf commands below.
function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith('--')) fail(`expected --flag, got "${args[i]}"`);
    out[args[i].slice(2)] = args[i + 1];
  }
  return out;
}

async function main() {
  if (cmd === 'element' && sub === 'create') {
    const f = parseFlags(rest);
    if (!f.type || !f.name) fail('usage: pipeline element create --type <t> --name <n>');
    const el = await createElement(REPO_ROOT, { type: f.type, name: f.name });
    console.log(`created element: ${el.dir}`);
  } else if (cmd === 'shot' && sub === 'create') {
    const f = parseFlags(rest);
    if (!f.id) fail('usage: pipeline shot create --id <shotId> [--duration <s>] [--mode <m>] [--description <d>]');
    const shot = await createShot(REPO_ROOT, {
      shotId: f.id,
      elements: [],
      duration: f.duration ? Number(f.duration) : null,
      mode: f.mode || null,
      description: f.description || '',
    });
    console.log(`created shot: ${shot.dir}`);
  } else if (cmd === 'shot' && sub === 'draft') {
    const f = parseFlags(rest);
    if (!f.id) fail('usage: pipeline shot draft --id <shotId>');
    const d = await newDraft(REPO_ROOT, f.id);
    console.log(`created draft ${d.version}: ${d.dir}`);
  } else if (cmd === 'shot' && sub === 'promote') {
    const f = parseFlags(rest);
    if (!f.id || !f.version || !f.output) {
      fail('usage: pipeline shot promote --id <shotId> --version <n> --output <file>');
    }
    const r = await promoteDraft(REPO_ROOT, f.id, Number(f.version), f.output);
    console.log(`promoted to final: ${r.finalPath}`);
  } else {
    fail([
      'usage:',
      '  pipeline element create --type <characters|props|scenes|other> --name <name>',
      '  pipeline shot create --id <shotId> [--duration <s>] [--mode <m>] [--description <d>]',
      '  pipeline shot draft --id <shotId>',
      '  pipeline shot promote --id <shotId> --version <n> --output <file>',
    ].join('\n'));
  }
}

main().catch((err) => fail(err.message));
