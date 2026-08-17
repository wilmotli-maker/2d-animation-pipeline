#!/usr/bin/env node
import { projectRoot, whisperModelPath, matteModelPath, matteThreads, MATTE_DEFAULT_QUALITY } from '../src/config.js';
import { createElement } from '../src/element.js';
import { createShot, newDraft, promoteDraft } from '../src/shot.js';
import { createRunner, inheritStderrExec } from '../src/cli.js';
import { generateElementSheet, generateShotDraft } from '../src/generate.js';
import { backfillPanels } from '../src/split-panels.js';
import { getTranscriber, transcribeInputs } from '../src/transcribe.js';
import { syncSkills } from '../src/sync-skills.js';
import { validateElementSheet, validateShotGenerate } from '../src/validate.js';
import { initProject } from '../src/init.js';
import { matteShot, matteEngine, MATTE_QUALITIES } from '../src/matte.js';
import { upscaleShot, UPSCALE_MODELS, UPSCALE_DEFAULT_MODEL } from '../src/upscale.js';

const [, , cmd, sub, ...rest] = process.argv;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// Print a ✓/⚠/✗ checklist and return true if there are no failures.
function printChecklist(result) {
  const mark = { pass: '✓', warn: '⚠', fail: '✗' };
  for (const c of result.checks) {
    console.log(`  ${mark[c.status] || '?'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  console.log(result.ok ? 'OK — inputs are valid.' : 'FAILED — fix the ✗ items above.');
  return result.ok;
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

// Collect every value for a repeatable flag (e.g. --image a --image b -> [a, b]).
function collectFlag(args, key) {
  const flag = `--${key}`;
  const vals = [];
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === flag && args[i + 1] != null) vals.push(args[i + 1]);
  }
  return vals;
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
  } else if (cmd === 'element' && sub === 'sheet') {
    const f = parseFlags(rest);
    if (!f.type || !f.name || !f.sheet || !f.id || !f.model) {
      fail('usage: pipeline element sheet --type <t> --name <n> --sheet <turnaround|pose|cycles> --id <slug> --model <m> [--prompt <p> | --prompt-file <file>] [--image <file> ...] [--root <dir>]');
    }
    const res = await generateElementSheet(projectRoot(f.root), {
      type: f.type, name: f.name, sheet: f.sheet, id: f.id, model: f.model,
      prompt: f.prompt, promptFile: f['prompt-file'], images: collectFlag(rest, 'image'),
    }, { runner: createRunner() });
    console.log(`saved ${res.version}: ${res.outputPath}`);
  } else if (cmd === 'element' && sub === 'split-panels') {
    const f = parseFlags(rest);
    const results = await backfillPanels(projectRoot(f.root), {
      type: f.type, name: f.name, sheet: f.sheet, id: f.id,
    });
    const split = results.filter((r) => r.status === 'split');
    const skipped = results.filter((r) => r.status === 'skipped');
    for (const r of split) console.log(`  + ${r.panelsDir} (${r.panels.length} panels)`);
    console.log(`split ${split.length} sheet(s), skipped ${skipped.length} already-split.`);
  } else if (cmd === 'voice' && sub === 'transcribe') {
    // --force is a bare boolean; the pair-based parsers can't see it, so pull it
    // out first and parse the rest as --key value.
    const argv = rest.filter((t) => t !== '--force');
    const force = argv.length !== rest.length;
    const f = parseFlags(argv);
    const audios = collectFlag(argv, 'audio');
    if (!audios.length && !f.dir) {
      fail('usage: pipeline voice transcribe --audio <file> [--audio <file> ...] [--out <file>] | --dir <folder> [--engine whisper] [--model-file <path>] [--force]');
    }
    const transcriber = getTranscriber(f.engine, { model: whisperModelPath(f['model-file']) });
    const results = await transcribeInputs(
      { audios, dir: f.dir || null, out: f.out || null, force },
      { transcriber },
    );
    for (const r of results) {
      console.log(`  ${r.status === 'transcribed' ? '+' : '='} ${r.sidecar}${r.status === 'skipped' ? ' (exists)' : ''}`);
    }
    const done = results.filter((r) => r.status === 'transcribed').length;
    console.log(`transcribed ${done}, skipped ${results.length - done}.`);
  } else if (cmd === 'shot' && sub === 'generate') {
    const f = parseFlags(rest);
    if (!f.id || !f.version || !f.model) {
      fail('usage: pipeline shot generate --id <shotId> --version <n> --model <m> [--prompt <p> | --prompt-file <file>] [--image <file> ...] [--speech-audio <wav>] [--video <file> ...] [--audio <file> ...] [--resolution <r>] [--duration <s>] [--aspect-ratio <a>] [--generate-audio <true|false>] [--mode <m>] [--root <dir>]');
    }
    const genVersion = Number(f.version);
    if (!Number.isInteger(genVersion) || genVersion < 1) {
      fail('shot generate: --version must be a positive integer');
    }
    const res = await generateShotDraft(projectRoot(f.root), {
      shotId: f.id, version: genVersion, model: f.model,
      prompt: f.prompt, promptFile: f['prompt-file'], images: collectFlag(rest, 'image'),
      speechAudio: f['speech-audio'], videos: collectFlag(rest, 'video'), audios: collectFlag(rest, 'audio'),
      resolution: f.resolution, duration: f.duration, aspectRatio: f['aspect-ratio'],
      generateAudio: f['generate-audio'], mode: f.mode,
    }, { runner: createRunner() });
    console.log(`saved shot draft output: ${res.outputPath}`);
  } else if (cmd === 'shot' && sub === 'matte') {
    const f = parseFlags(rest);
    if (!f.id) {
      fail('usage: pipeline shot matte --id <shotId> [--version <n|final>] [--quality fast|best] [--format prores4444|webm|png] [--despill <true|false>] [--threads <n>] [--input <file>] [--model-file <path>] [--root <dir>]');
    }
    if (f.despill != null && f.despill !== 'true' && f.despill !== 'false') {
      fail('shot matte: --despill must be true or false');
    }
    const quality = f.quality || MATTE_DEFAULT_QUALITY;
    if (!MATTE_QUALITIES.includes(quality)) {
      fail(`shot matte: --quality must be one of ${MATTE_QUALITIES.join(', ')}`);
    }
    if (f.threads != null && !(Number.isInteger(Number(f.threads)) && Number(f.threads) > 0)) {
      fail('shot matte: --threads must be a positive integer');
    }
    const version = f.version == null || f.version === 'final' ? null : Number(f.version);
    if (version != null && (!Number.isInteger(version) || version < 1)) {
      fail('shot matte: --version must be a positive integer or "final"');
    }
    const res = await matteShot(projectRoot(f.root), {
      shotId: f.id, version, format: f.format || 'prores4444', input: f.input,
      despill: f.despill !== 'false',
    }, {
      engine: matteEngine({
        quality,
        model: f['model-file'] || matteModelPath(null, quality),
        threads: matteThreads(f.threads),
      }),
    });
    console.log(`matted ${res.frames} frames from ${res.source}`);
    console.log(`  -> ${res.output} (${res.secondsPerFrame}s/frame, quality ${res.quality}, coverage ${res.meanCoverage})`);
    if (res.edgeGreenBefore != null) {
      const pct = (v) => `${(v * 100).toFixed(1)}%`;
      console.log(`  despill: edge spill ${pct(res.edgeGreenBefore)} -> ${pct(res.edgeGreenAfter)}`);
    }
  } else if (cmd === 'shot' && sub === 'upscale') {
    const f = parseFlags(rest);
    if (!f.id) {
      fail('usage: pipeline shot upscale --id <shotId> [--version <n|final>] [--model topaz_video|bytedance_video_upscale] [--resolution <r>] [--aspect-ratio <a>] [--input <file>] [--root <dir>]');
    }
    const model = f.model || UPSCALE_DEFAULT_MODEL;
    if (!UPSCALE_MODELS[model]) {
      fail(`shot upscale: --model must be one of ${Object.keys(UPSCALE_MODELS).join(', ')}`);
    }
    const version = f.version == null || f.version === 'final' ? null : Number(f.version);
    if (version != null && (!Number.isInteger(version) || version < 1)) {
      fail('shot upscale: --version must be a positive integer or "final"');
    }
    const res = await upscaleShot(projectRoot(f.root), {
      shotId: f.id, version, input: f.input, model,
      resolution: f.resolution, aspectRatio: f['aspect-ratio'],
      modelVersion: f['model-version'], preset: f.preset, fps: f.fps,
      // The upscaler create call hangs if stderr is a captured pipe; inherit it.
    }, { runner: createRunner({ exec: inheritStderrExec }) });
    console.log(`upscaled ${res.source}`);
    console.log(`  -> ${res.outputPath} (${res.model}, ${res.resolution}, job ${res.jobId})`);
  } else if (cmd === 'verify' && sub === 'element') {
    const f = parseFlags(rest);
    if (!f.type || !f.name || !f.sheet || !f.id) {
      fail('usage: pipeline verify element --type <t> --name <n> --sheet <turnaround|pose|cycles> --id <slug> [--prompt <p> | --prompt-file <file>] [--image <file> ...] [--root <dir>]');
    }
    const result = await validateElementSheet(projectRoot(f.root), {
      type: f.type, name: f.name, sheet: f.sheet, id: f.id,
      prompt: f.prompt, promptFile: f['prompt-file'], images: collectFlag(rest, 'image'),
    });
    if (!printChecklist(result)) process.exit(1);
  } else if (cmd === 'verify' && sub === 'shot') {
    const f = parseFlags(rest);
    if (!f.id || !f.version) {
      fail('usage: pipeline verify shot --id <shotId> --version <n> [--prompt <p> | --prompt-file <file>] [--image <file> ...] [--speech-audio <wav>] [--video <file> ...] [--audio <file> ...] [--resolution <r>] [--duration <s>] [--aspect-ratio <a>] [--generate-audio <true|false>] [--root <dir>]');
    }
    const result = await validateShotGenerate(projectRoot(f.root), {
      shotId: f.id, version: Number(f.version),
      prompt: f.prompt, promptFile: f['prompt-file'], images: collectFlag(rest, 'image'),
      speechAudio: f['speech-audio'], videos: collectFlag(rest, 'video'), audios: collectFlag(rest, 'audio'),
      resolution: f.resolution, duration: f.duration, aspectRatio: f['aspect-ratio'],
      generateAudio: f['generate-audio'],
    });
    if (!printChecklist(result)) process.exit(1);
  } else if (cmd === 'init') {
    const target = sub;
    if (!target) fail('usage: pipeline init <dir>');
    const res = await initProject(target);
    console.log(`initialized project: ${res.dir}`);
    for (const file of res.files) console.log(`  + ${file}`);
    console.log('next: cd into it, run `claude`, then use the element-author skill.');
  } else if (cmd === 'sync-skills') {
    // Single-word command with only an optional --root; `sub` may carry the flag.
    const f = parseFlags([sub, ...rest].filter((x) => x != null));
    const results = await syncSkills(projectRoot(f.root));
    for (const r of results) {
      console.log(`  ${r.status === 'unchanged' ? '=' : '+'} .claude/skills/${r.name}/SKILL.md (${r.status})`);
    }
    const changed = results.filter((r) => r.status !== 'unchanged').length;
    console.log(`synced ${results.length} skill(s), ${changed} added/updated.`);
  } else {
    fail([
      'usage:',
      '  pipeline init <dir>                        # scaffold a new project folder',
      '  pipeline sync-skills [--root <dir>]        # refresh a project\'s .claude/skills/ from the current templates',
      '  pipeline element create --type <characters|props|scenes|other> --name <name> [--root <dir>]',
      '  pipeline shot create --id <shotId> [--duration <s>] [--mode <m>] [--description <d>] [--root <dir>]',
      '  pipeline shot draft --id <shotId> [--root <dir>]',
      '  pipeline shot promote --id <shotId> --version <n> --output <file> [--root <dir>]',
      '  pipeline shot matte --id <shotId> [--version <n|final>] [--quality fast|best] [--format prores4444|webm|png] [--despill <true|false>] [--threads <n>] [--input <file>] [--model-file <path>]  # RGBA from a finalized clip',
      '  pipeline shot upscale --id <shotId> [--version <n|final>] [--model topaz_video|bytedance_video_upscale] [--resolution <r>] [--aspect-ratio <a>] [--input <file>]  # enlarge a finalized clip to 1080p+',
      '        --quality fast (default) is isnet-general-use: 7x quicker, structurally equivalent, with a slightly wider/softer edge. --quality best is BiRefNet-DIS — tighter edges, ~7x slower, and required to reproduce mattes made before fast became the default.',
      '  pipeline element sheet --type <t> --name <n> --sheet <turnaround|pose|cycles> --id <slug> --model <m> [--prompt <p> | --prompt-file <file>] [--image <file> ...]',
      '  pipeline element split-panels [--type <t>] [--name <n>] [--sheet <turnaround|pose>] [--id <slug>] [--root <dir>]  # backfill panel folders for existing sheets',
      '  pipeline shot generate --id <shotId> --version <n> --model <m> [--prompt <p> | --prompt-file <file>] [--image <file> ...] [--speech-audio <wav>] [--video <file> ...] [--audio <file> ...] [--resolution <r>] [--duration <s>] [--aspect-ratio <a>] [--generate-audio <true|false>] [--mode <m>]',
      '  pipeline verify element --type <t> --name <n> --sheet <turnaround|pose|cycles> --id <slug> [--prompt <p> | --prompt-file <file>] [--image <file> ...]',
      '  pipeline verify shot --id <shotId> --version <n> [--prompt <p> | --prompt-file <file>] [--image <file> ...] [--speech-audio <wav>] [--video <file> ...] [--audio <file> ...]',
      '  pipeline voice transcribe --audio <file> [--audio <file> ...] [--out <file>] | --dir <folder> [--engine whisper] [--model-file <path>] [--force]  # exact transcript sidecars for lip-sync prompts',
      '',
      '--image / --video / --audio are repeatable: pass each multiple times to',
      'send several references. For talking-character (Seedance) shots, pass the',
      'speech recording via --speech-audio <wav>: it is wrapped into a blank',
      'mid-gray video and sent as a video reference, which reproduces the',
      "recording's exact words and pacing. Needs ffmpeg on PATH.",
      'Project data (elements/, shots/) is written under --root, else',
      '$ANIMATION_PIPELINE_ROOT, else the current directory.',
    ].join('\n'));
  }
}

main().catch((err) => fail(err.message));
