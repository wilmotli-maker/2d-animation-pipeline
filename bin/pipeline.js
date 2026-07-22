#!/usr/bin/env node
import { projectRoot } from '../src/config.js';
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
    if (!f.type || !f.name) fail('usage: pipeline element create --type <t> --name <n> [--root <dir>]');
    const el = await createElement(projectRoot(f.root), { type: f.type, name: f.name });
    console.log(`created element: ${el.dir}`);
  } else if (cmd === 'shot' && sub === 'create') {
    const f = parseFlags(rest);
    if (!f.id) fail('usage: pipeline shot create --id <shotId> [--duration <s>] [--mode <m>] [--description <d>] [--root <dir>]');
    const shot = await createShot(projectRoot(f.root), {
      shotId: f.id,
      elements: [],
      duration: f.duration ? Number(f.duration) : null,
      mode: f.mode || null,
      description: f.description || '',
    });
    console.log(`created shot: ${shot.dir}`);
  } else if (cmd === 'shot' && sub === 'draft') {
    const f = parseFlags(rest);
    if (!f.id) fail('usage: pipeline shot draft --id <shotId> [--root <dir>]');
    const d = await newDraft(projectRoot(f.root), f.id);
    console.log(`created draft ${d.version}: ${d.dir}`);
  } else if (cmd === 'shot' && sub === 'promote') {
    const f = parseFlags(rest);
    if (!f.id || !f.version || !f.output) {
      fail('usage: pipeline shot promote --id <shotId> --version <n> --output <file> [--root <dir>]');
    }
    const r = await promoteDraft(projectRoot(f.root), f.id, Number(f.version), f.output);
    console.log(`promoted to final: ${r.finalPath}`);
  } else {
    fail([
      'usage:',
      '  pipeline element create --type <characters|props|scenes|other> --name <name> [--root <dir>]',
      '  pipeline shot create --id <shotId> [--duration <s>] [--mode <m>] [--description <d>] [--root <dir>]',
      '  pipeline shot draft --id <shotId> [--root <dir>]',
      '  pipeline shot promote --id <shotId> --version <n> --output <file> [--root <dir>]',
      '',
      'Project data (elements/, shots/) is written under --root, else',
      '$ANIMATION_PIPELINE_ROOT, else the current directory.',
    ].join('\n'));
  }
}

main().catch((err) => fail(err.message));
