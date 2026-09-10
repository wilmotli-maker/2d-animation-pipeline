#!/usr/bin/env node
import { loadEnv } from '../src/env.js';
import { projectRoot, whisperModelPath, matteModelPath, matteThreads, MATTE_DEFAULT_QUALITY } from '../src/config.js';
import { createElement } from '../src/element.js';
import { createShot, newDraft, promoteDraft } from '../src/shot.js';
import { createRunner, inheritStderrExec } from '../src/cli.js';
import { generateElementSheet, generateShotDraft, generateElementSheetsBatch, generateShotDraftsBatch } from '../src/generate.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { backfillPanels } from '../src/split-panels.js';
import { getTranscriber, transcribeInputs } from '../src/transcribe.js';
import { syncSkills } from '../src/sync-skills.js';
import { validateElementSheet, validateShotGenerate } from '../src/validate.js';
import { initProject } from '../src/init.js';
import {
  matteShot, matteEngine, plateMatteEngine,
  MATTE_QUALITIES, MATTE_METHODS, MATTE_DEFAULT_METHOD,
  MATTE_KEY_ENGINES, MATTE_CORES, MATTE_REFINES,
  MATTE_DEFAULT_CORE, MATTE_DEFAULT_REFINE,
  MATTE_REFINE_TRIMAPS, MATTE_DEFAULT_REFINE_TRIMAP, keyEngineToComposition,
} from '../src/matte.js';
import { upscaleShot, UPSCALE_MODELS, UPSCALE_DEFAULT_MODEL } from '../src/upscale.js';
import { upscaleImage, UPSCALE_IMAGE_MODELS, UPSCALE_IMAGE_DEFAULT_MODEL } from '../src/upscale-image.js';
import { reportFromLogs, formatReportTable, reconcile, formatReconcileTable, tagCredits, backfillCredits, setTaskState, clearTaskState, readTaskState } from '../src/credits.js';
import { buildReviewPage, parseReviewArgs } from '../src/review-page.js';

// Load private API keys from a gitignored .env (shell env still wins) so every
// command sees provider credentials without a manual export. See .env.example.
loadEnv();

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

// Load a batch manifest: a JSON array of per-item specs, or an object
// { concurrency?, items: [...] }. Returns { items, concurrency }.
async function loadManifest(file) {
  let raw;
  try { raw = await readFile(file, 'utf8'); } catch (e) { fail(`cannot read manifest ${file}: ${e.message}`); }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { fail(`manifest ${file} is not valid JSON: ${e.message}`); }
  const items = Array.isArray(parsed) ? parsed : parsed.items;
  if (!Array.isArray(items) || !items.length) {
    fail(`manifest ${file} must be a non-empty JSON array of specs (or { items: [...] })`);
  }
  const concurrency = Array.isArray(parsed) ? undefined : parsed.concurrency;
  return { items, concurrency };
}

// Print per-job results and exit non-zero if any failed.
function reportBatch(label, results) {
  let failed = 0;
  for (const r of results) {
    if (r.ok) {
      console.log(`  ✓ ${r.ref} -> ${r.outputPath}${r.task ? `  [task: ${r.task}]` : ''}`);
    } else {
      failed += 1;
      console.log(`  ✗ ${r.ref || '(unprepared)'} — ${r.error}`);
    }
  }
  const ok = results.length - failed;
  console.log(`${label}: ${ok} succeeded, ${failed} failed (of ${results.length}).`);
  if (failed) process.exit(1);
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
  } else if (cmd === 'review') {
    const opts = parseReviewArgs(sub, rest);
    if (!opts.slug) fail('usage: pipeline review <shots|images> --slug <name> [--match <re>] [--exclude <re>] [--folder <dir>] [--characters a,b] [--episode N,M] [--sheets turnaround,pose] [--layout side-by-side|stacked] [--update] [--title ..] [--out <dir>] [--root <dir>]');
    const res = await buildReviewPage(projectRoot(opts.root), opts);
    console.log(`review page: ${res.pageDir}  (${res.count} item(s))`);
  } else if (cmd === 'element' && sub === 'sheet') {
    const f = parseFlags(rest);
    if (!f.type || !f.name || !f.sheet || !f.id || !f.model) {
      fail('usage: pipeline element sheet --type <t> --name <n> --sheet <turnaround|pose|cycles> --id <slug> --model <m> [--prompt <p> | --prompt-file <file>] [--image <file> ...] [--root <dir>]');
    }
    const res = await generateElementSheet(projectRoot(f.root), {
      type: f.type, name: f.name, sheet: f.sheet, id: f.id, model: f.model,
      prompt: f.prompt, promptFile: f['prompt-file'], images: collectFlag(rest, 'image'),
      task: f.task,
    }, { runner: createRunner() });
    console.log(`saved ${res.version}: ${res.outputPath}${res.task ? `  [task: ${res.task}]` : ''}`);
  } else if (cmd === 'element' && sub === 'sheet-batch') {
    const f = parseFlags(rest);
    if (!f.manifest) {
      fail('usage: pipeline element sheet-batch --manifest <file.json> [--concurrency <n>] [--root <dir>]\n' +
        '  manifest: JSON array of { type, name, sheet, id, model, prompt|prompt-file|promptFile, images?, task? }');
    }
    const { items, concurrency: manifestConc } = await loadManifest(f.manifest);
    const concurrency = f.concurrency != null ? Number(f.concurrency) : (manifestConc ?? 8);
    if (!Number.isInteger(concurrency) || concurrency < 1) fail('--concurrency must be a positive integer');
    const specs = items.map((it) => ({
      ref: `${it.name}/${it.sheet}/${it.id}`,
      type: it.type, name: it.name, sheet: it.sheet, id: it.id, model: it.model,
      prompt: it.prompt, promptFile: it['prompt-file'] ?? it.promptFile, images: it.images || [],
      task: it.task,
    }));
    const results = await generateElementSheetsBatch(projectRoot(f.root), specs, {
      runner: createRunner(), concurrency,
    });
    reportBatch('element sheet-batch', results);
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
      generateAudio: f['generate-audio'], mode: f.mode, task: f.task,
    }, { runner: createRunner() });
    console.log(`saved shot draft output: ${res.outputPath}${res.task ? `  [task: ${res.task}]` : ''}`);
  } else if (cmd === 'shot' && sub === 'generate-batch') {
    const f = parseFlags(rest);
    if (!f.manifest) {
      fail('usage: pipeline shot generate-batch --manifest <file.json> [--concurrency <n>] [--root <dir>]\n' +
        '  manifest: JSON array of { id, version, model, prompt|prompt-file|promptFile, images?, speechAudio?, videos?, audios?, resolution?, duration?, aspectRatio?, generateAudio?, mode?, task? }');
    }
    const { items, concurrency: manifestConc } = await loadManifest(f.manifest);
    const concurrency = f.concurrency != null ? Number(f.concurrency) : (manifestConc ?? 8);
    if (!Number.isInteger(concurrency) || concurrency < 1) fail('--concurrency must be a positive integer');
    const specs = items.map((it, i) => {
      const version = Number(it.version);
      if (!Number.isInteger(version) || version < 1) {
        fail(`shot generate-batch: item ${i} (${it.id ?? '?'}) needs an integer version >= 1`);
      }
      return {
        ref: `${it.id}/v${version}`,
        shotId: it.id, version, model: it.model,
        prompt: it.prompt, promptFile: it['prompt-file'] ?? it.promptFile, images: it.images || [],
        speechAudio: it.speechAudio ?? it['speech-audio'], videos: it.videos || [], audios: it.audios || [],
        resolution: it.resolution, duration: it.duration,
        aspectRatio: it.aspectRatio ?? it['aspect-ratio'],
        generateAudio: it.generateAudio ?? it['generate-audio'], mode: it.mode, task: it.task,
      };
    });
    const results = await generateShotDraftsBatch(projectRoot(f.root), specs, {
      runner: createRunner(), concurrency,
    });
    reportBatch('shot generate-batch', results);
  } else if (cmd === 'shot' && sub === 'matte') {
    const f = parseFlags(rest);
    if (!f.id) {
      fail('usage: pipeline shot matte --id <shotId> [--version <n|final>] [--method ml|plate] [--quality fast|best] [--format prores4444|webm|png] [--despill <true|false>] [--threads <n>] [--feather <px>] [--matte chroma|keylight] [--refine none|closed-form] [--refine-trimap alpha|plate] [--plate-spread <n>] [--screen-colour <#rrggbb|auto>] [--screen-balance <0..1>] [--clip-black <0..1>] [--clip-white <0..1>] [--screen-gain <n>] [--screen-pre-blur <px>] [--despill-bias <#rrggbb|auto>] [--inside-mask <file|dir>] [--outside-mask <file|dir>] [--input <file>] [--model-file <path>] [--root <dir>]  (--key-engine trimap|keylight is a deprecated alias for --matte/--refine)');
    }
    const method = f.method || MATTE_DEFAULT_METHOD;
    if (!MATTE_METHODS.includes(method)) {
      fail(`shot matte: --method must be one of ${MATTE_METHODS.join(', ')}`);
    }
    if (f.despill != null && f.despill !== 'true' && f.despill !== 'false') {
      fail('shot matte: --despill must be true or false');
    }
    const version = f.version == null || f.version === 'final' ? null : Number(f.version);
    if (version != null && (!Number.isInteger(version) || version < 1)) {
      fail('shot matte: --version must be a positive integer or "final"');
    }

    // Keylight-only flags (valid only with --method plate --key-engine keylight).
    const KEYLIGHT_FLAGS = ['screen-colour', 'screen-balance', 'clip-black', 'clip-white',
      'screen-gain', 'screen-pre-blur', 'despill-bias', 'inside-mask', 'outside-mask'];
    const isColour = (v) => v === 'auto' || /^#?[0-9a-fA-F]{6}$/.test(v);
    const inRange = (v) => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1;

    let engine;
    if (method === 'plate') {
      // Plate matte ignores the ML-only knobs (quality/model-file/threads).
      for (const k of ['quality', 'model-file', 'threads']) {
        if (f[k] != null) fail(`shot matte --method plate: --${k} does not apply (that is an ML-method flag)`);
      }
      if (f.feather != null && !(Number(f.feather) >= 0)) {
        fail('shot matte: --feather must be a non-negative number');
      }
      // Resolve the matte core + refine from --matte/--refine, or the deprecated
      // --key-engine alias. Mixing the two is refused.
      const usingNew = f.matte != null || f.refine != null;
      const usingAlias = f['key-engine'] != null;
      if (usingNew && usingAlias) {
        fail('shot matte: use --matte/--refine or the deprecated --key-engine, not both');
      }
      let core, refine;
      if (usingAlias) {
        if (!MATTE_KEY_ENGINES.includes(f['key-engine'])) {
          fail(`shot matte: --key-engine must be one of ${MATTE_KEY_ENGINES.join(', ')}`);
        }
        ({ core, refine } = keyEngineToComposition(f['key-engine']));
      } else {
        core = f.matte || MATTE_DEFAULT_CORE;
        refine = f.refine || (core === 'keylight' ? 'none' : MATTE_DEFAULT_REFINE);
        if (!MATTE_CORES.includes(core)) {
          fail(`shot matte: --matte must be one of ${MATTE_CORES.join(', ')}`);
        }
        if (!MATTE_REFINES.includes(refine)) {
          fail(`shot matte: --refine must be one of ${MATTE_REFINES.join(', ')}`);
        }
        if (core === 'chroma' && refine !== 'closed-form') {
          fail('shot matte: --matte chroma requires --refine closed-form (it has no final alpha of its own)');
        }
      }
      // --refine-trimap: how a keylight+closed-form solve seeds its trimap.
      let refineTrimap = MATTE_DEFAULT_REFINE_TRIMAP;
      if (f['refine-trimap'] != null) {
        if (!MATTE_REFINE_TRIMAPS.includes(f['refine-trimap'])) {
          fail(`shot matte: --refine-trimap must be one of ${MATTE_REFINE_TRIMAPS.join(', ')}`);
        }
        if (!(core === 'keylight' && refine === 'closed-form')) {
          fail('shot matte: --refine-trimap only applies to --matte keylight --refine closed-form');
        }
        refineTrimap = f['refine-trimap'];
      }
      // --plate-spread: manual override of the auto-detected plate spread used by
      // the chroma trimap (chroma core, or keylight --refine-trimap plate).
      let plateSpread = null;
      if (f['plate-spread'] != null) {
        if (!(Number(f['plate-spread']) >= 0)) fail('shot matte: --plate-spread must be a non-negative number');
        plateSpread = Number(f['plate-spread']);
      }
      const keylight = {};
      if (core === 'keylight') {
        if (f['screen-colour'] != null) {
          if (!isColour(f['screen-colour'])) fail('shot matte: --screen-colour must be #rrggbb or "auto"');
          keylight.screenColour = f['screen-colour'].startsWith('#') || f['screen-colour'] === 'auto'
            ? f['screen-colour'] : `#${f['screen-colour']}`;
        }
        if (f['despill-bias'] != null) {
          if (!isColour(f['despill-bias'])) fail('shot matte: --despill-bias must be #rrggbb or "auto"');
          keylight.despillBias = f['despill-bias'].startsWith('#') || f['despill-bias'] === 'auto'
            ? f['despill-bias'] : `#${f['despill-bias']}`;
        }
        for (const [flag, key] of [['screen-balance', 'screenBalance'],
          ['clip-black', 'clipBlack'], ['clip-white', 'clipWhite']]) {
          if (f[flag] != null) {
            if (!inRange(f[flag])) fail(`shot matte: --${flag} must be a number in [0,1]`);
            keylight[key] = Number(f[flag]);
          }
        }
        for (const [flag, key] of [['screen-gain', 'screenGain'], ['screen-pre-blur', 'screenPreBlur']]) {
          if (f[flag] != null) {
            if (!(Number(f[flag]) >= 0)) fail(`shot matte: --${flag} must be a non-negative number`);
            keylight[key] = Number(f[flag]);
          }
        }
        for (const [flag, key] of [['inside-mask', 'insideMask'], ['outside-mask', 'outsideMask']]) {
          if (f[flag] != null) {
            if (!existsSync(f[flag])) fail(`shot matte: --${flag} not found: ${f[flag]}`);
            keylight[key] = f[flag];
          }
        }
      } else {
        // chroma: the Keylight controls are meaningless — refuse them rather than
        // silently ignore, so a misremembered command fails loudly.
        for (const k of KEYLIGHT_FLAGS) {
          if (f[k] != null) fail(`shot matte --matte chroma: --${k} only applies to --matte keylight`);
        }
      }
      engine = plateMatteEngine({
        feather: f.feather != null ? Number(f.feather) : null,
        core, refine, refineTrimap, plateSpread, keylight,
      });
    } else {
      if (f.feather != null) fail('shot matte --method ml: --feather does not apply (that is a plate-method flag)');
      for (const k of ['key-engine', 'matte', 'refine', 'refine-trimap', 'plate-spread', ...KEYLIGHT_FLAGS]) {
        if (f[k] != null) fail(`shot matte --method ml: --${k} does not apply (that is a plate-method flag)`);
      }
      const quality = f.quality || MATTE_DEFAULT_QUALITY;
      if (!MATTE_QUALITIES.includes(quality)) {
        fail(`shot matte: --quality must be one of ${MATTE_QUALITIES.join(', ')}`);
      }
      if (f.threads != null && !(Number.isInteger(Number(f.threads)) && Number(f.threads) > 0)) {
        fail('shot matte: --threads must be a positive integer');
      }
      engine = matteEngine({
        quality,
        model: f['model-file'] || matteModelPath(null, quality),
        threads: matteThreads(f.threads),
      });
    }

    const res = await matteShot(projectRoot(f.root), {
      shotId: f.id, version, format: f.format || 'prores4444', input: f.input,
      despill: f.despill !== 'false',
    }, { engine });
    console.log(`matted ${res.frames} frames from ${res.source}`);
    const tag = method === 'plate'
      ? `plate ${res.matte}+${res.refine}${res.refineTrimap === 'plate' ? '(plate-trimap)' : ''}, key ${res.key}`
      : `quality ${res.quality}`;
    console.log(`  -> ${res.output} (${res.secondsPerFrame}s/frame, ${tag}, coverage ${res.meanCoverage})`);
    // ml despill reports edgeGreen{Before,After}; keylight reports edgeSpill{Before,After}.
    const spillBefore = res.edgeGreenBefore ?? res.edgeSpillBefore;
    const spillAfter = res.edgeGreenAfter ?? res.edgeSpillAfter;
    if (spillBefore != null) {
      const pct = (v) => `${(v * 100).toFixed(1)}%`;
      console.log(`  despill: edge spill ${pct(spillBefore)} -> ${pct(spillAfter)}`);
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
      modelVersion: f['model-version'], preset: f.preset, fps: f.fps, task: f.task,
      // The upscaler create call hangs if stderr is a captured pipe; inherit it.
    }, { runner: createRunner({ exec: inheritStderrExec }) });
    console.log(`upscaled ${res.source}${res.task ? `  [task: ${res.task}]` : ''}`);
    console.log(`  -> ${res.outputPath} (${res.model}, ${res.resolution}, job ${res.jobId})`);
  } else if (cmd === 'element' && sub === 'upscale') {
    const f = parseFlags(rest);
    if (!f.type || !f.name || !f.sheet || !f.id) {
      fail('usage: pipeline element upscale --type <t> --name <n> --sheet <turnaround|pose|cycles> --id <slug> [--version <n|latest>] [--model topaz_image|bytedance_image_upscale] [--scale 2|4] [--input <file>] [--root <dir>]');
    }
    const model = f.model || UPSCALE_IMAGE_DEFAULT_MODEL;
    if (!UPSCALE_IMAGE_MODELS[model]) {
      fail(`element upscale: --model must be one of ${Object.keys(UPSCALE_IMAGE_MODELS).join(', ')}`);
    }
    const scale = Number(f.scale ?? 2);
    const res = await upscaleImage(projectRoot(f.root), {
      mode: 'element', type: f.type, name: f.name, sheet: f.sheet, id: f.id,
      version: f.version, input: f.input, model, scale, task: f.task,
    }, { runner: createRunner({ exec: inheritStderrExec }) });
    console.log(`upscaled ${res.source}${res.task ? `  [task: ${res.task}]` : ''}`);
    console.log(`  -> ${res.outputPath} (${res.model}, ${res.scale}x)`);
    if (res.panels) console.log(`  panels: ${res.panelsDir} (${res.panels.length})`);
  } else if (cmd === 'image' && sub === 'upscale') {
    const f = parseFlags(rest);
    if (!f.input) {
      fail('usage: pipeline image upscale --input <file> [--model topaz_image|bytedance_image_upscale] [--scale 2|4] [--out <dir>] [--root <dir>]');
    }
    const model = f.model || UPSCALE_IMAGE_DEFAULT_MODEL;
    if (!UPSCALE_IMAGE_MODELS[model]) {
      fail(`image upscale: --model must be one of ${Object.keys(UPSCALE_IMAGE_MODELS).join(', ')}`);
    }
    const scale = Number(f.scale ?? 2);
    const res = await upscaleImage(projectRoot(f.root), {
      mode: 'image', input: f.input, out: f.out, model, scale, task: f.task,
    }, { runner: createRunner({ exec: inheritStderrExec }) });
    console.log(`upscaled ${res.source}${res.task ? `  [task: ${res.task}]` : ''}`);
    console.log(`  -> ${res.outputPath} (${res.model}, ${res.scale}x, job ${res.jobId})`);
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
      fail('usage: pipeline verify shot --id <shotId> --version <n> [--model <m>] [--prompt <p> | --prompt-file <file>] [--image <file> ...] [--speech-audio <wav>] [--video <file> ...] [--audio <file> ...] [--resolution <r>] [--duration <s>] [--aspect-ratio <a>] [--generate-audio <true|false>] [--root <dir>]');
    }
    const result = await validateShotGenerate(projectRoot(f.root), {
      shotId: f.id, version: Number(f.version), model: f.model,
      prompt: f.prompt, promptFile: f['prompt-file'], images: collectFlag(rest, 'image'),
      speechAudio: f['speech-audio'], videos: collectFlag(rest, 'video'), audios: collectFlag(rest, 'audio'),
      resolution: f.resolution, duration: f.duration, aspectRatio: f['aspect-ratio'],
      generateAudio: f['generate-audio'],
    });
    if (!printChecklist(result)) process.exit(1);
  } else if (cmd === 'credits' && sub === 'report') {
    const savedOnly = rest.includes('--saved-only');
    const asJson = rest.includes('--json');
    const argv = rest.filter((t) => t !== '--saved-only' && t !== '--json');
    const f = parseFlags(argv);
    const report = await reportFromLogs(projectRoot(f.root), {
      type: f.type, name: f.name, sheet: f.sheet,
      since: f.since, until: f.until, task: f.task,
      by: f.by || 'sheet', savedOnly,
    });
    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatReportTable(report));
    }
  } else if (cmd === 'credits' && sub === 'reconcile') {
    const argv = rest.filter((t) => t !== '--exclude-unbilled' && t !== '--json');
    const excludeUnbilled = rest.includes('--exclude-unbilled');
    const asJson = rest.includes('--json');
    const f = parseFlags(argv);
    if (!f.since) fail('usage: pipeline credits reconcile --since <ISO> [--until <ISO>] [--exclude-unbilled] [--json] [--root <dir>]');
    const report = await reconcile(projectRoot(f.root), {
      since: f.since, until: f.until, excludeUnbilled,
      runner: createRunner(),
    });
    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatReconcileTable(report));
    }
  } else if (cmd === 'credits' && sub === 'tag') {
    const f = parseFlags(rest);
    if (!f.task || !f.since) {
      fail('usage: pipeline credits tag --task <label> --since <ISO> [--until <ISO>] [--sheet <slug>] [--type <t>] [--name <n>] [--root <dir>]');
    }
    const result = await tagCredits(projectRoot(f.root), {
      task: f.task, since: f.since, until: f.until,
      sheet: f.sheet, type: f.type, name: f.name,
    });
    console.log(`tagged ${result.tagged} entries with task "${result.task}"`);
  } else if (cmd === 'task') {
    // Active credit task for a project root — a persistent fallback for --task /
    // PIPELINE_TASK so a session of iteration is tagged without re-passing it.
    if (sub === 'set') {
      const label = rest.find((t) => !t.startsWith('--'));
      const f = parseFlags(rest.filter((t) => t !== label));
      if (!label) fail('usage: pipeline task set <label> [--root <dir>]');
      const root = projectRoot(f.root);
      await setTaskState(root, label);
      console.log(`active task set: ${label}\n(applies to gens under this project until \`pipeline task clear\`)`);
    } else if (sub === 'clear') {
      const f = parseFlags(rest);
      const had = await clearTaskState(projectRoot(f.root));
      console.log(had ? 'active task cleared' : 'no active task was set');
    } else if (sub == null || sub === 'show' || sub === 'get' || sub.startsWith('--')) {
      // `pipeline task`, `pipeline task show`, or `pipeline task --root <dir>`.
      const f = parseFlags(sub == null || !sub.startsWith('--') ? rest : [sub, ...rest]);
      const active = await readTaskState(projectRoot(f.root));
      const env = process.env.PIPELINE_TASK;
      if (env) console.log(`PIPELINE_TASK env: ${env}  (overrides the project task)`);
      console.log(active ? `active task: ${active}` : 'no active task set');
    } else {
      fail('usage: pipeline task [set <label> | show | clear] [--root <dir>]');
    }
  } else if (cmd === 'credits' && sub === 'backfill') {
    const f = parseFlags(rest);
    const result = await backfillCredits(projectRoot(f.root), {
      type: f.type, name: f.name, sheet: f.sheet,
      since: f.since, until: f.until,
    });
    console.log(`backfilled ${result.updated} entries (${result.skipped} skipped — already set or variable model)`);
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
      '  pipeline shot matte --id <shotId> [--version <n|final>] [--method ml|plate] [--quality fast|best] [--format prores4444|webm|png] [--despill <true|false>] [--threads <n>] [--feather <px>] [--input <file>] [--model-file <path>]  # RGBA from a finalized clip',
      '        --method ml (default) is the learned, background-agnostic segmenter (--quality/--threads/--model-file apply). --method plate is a trimap+closed-form matte for clips shot on a designed solid plate (chroma key): auto-detects the plate colour, no weights, crisper edges + correct interiors on flat 2D art (--feather applies, default 1.2).',
      '  pipeline shot upscale --id <shotId> [--version <n|final>] [--model topaz_video|bytedance_video_upscale] [--resolution <r>] [--aspect-ratio <a>] [--input <file>]  # enlarge a finalized clip to 1080p+',
      '  pipeline element upscale --type <t> --name <n> --sheet <turnaround|pose|cycles> --id <slug> [--version <n|latest>] [--model topaz_image|bytedance_image_upscale] [--scale 2|4] [--input <file>]  # enlarge a sheet (panel-aware for turnaround/pose)',
      '  pipeline image upscale --input <file> [--model topaz_image|bytedance_image_upscale] [--scale 2|4] [--out <dir>]  # enlarge any single image',
      '        --quality fast (default) is isnet-general-use: 7x quicker, structurally equivalent, with a slightly wider/softer edge. --quality best is BiRefNet-DIS — tighter edges, ~7x slower, and required to reproduce mattes made before fast became the default.',
      '  pipeline element sheet --type <t> --name <n> --sheet <turnaround|pose|cycles> --id <slug> --model <m> [--prompt <p> | --prompt-file <file>] [--image <file> ...] [--task <label>]',
      '  pipeline element split-panels [--type <t>] [--name <n>] [--sheet <turnaround|pose>] [--id <slug>] [--root <dir>]  # backfill panel folders for existing sheets',
      '  pipeline shot generate --id <shotId> --version <n> --model <m> [--prompt <p> | --prompt-file <file>] [--image <file> ...] [--speech-audio <wav>] [--video <file> ...] [--audio <file> ...] [--resolution <r>] [--duration <s>] [--aspect-ratio <a>] [--generate-audio <true|false>] [--mode <m>] [--task <label>]',
      '  pipeline shot generate-batch --manifest <file.json> [--concurrency <n=8>] [--root <dir>]   # generate many shot drafts in parallel from one JSON manifest',
      '  pipeline element sheet-batch --manifest <file.json> [--concurrency <n=8>] [--root <dir>]   # generate many element sheets in parallel from one JSON manifest',
      '  pipeline credits tag --task <label> --since <ISO> [--until <ISO>] [--sheet <slug>] [--type <t>] [--name <n>] [--root <dir>]',
      '  pipeline credits backfill [--root <ep>] [--type <t> --name <n>] [--sheet <slug>] [--since <ISO>] [--until <ISO>]',
      '  pipeline verify element --type <t> --name <n> --sheet <turnaround|pose|cycles> --id <slug> [--prompt <p> | --prompt-file <file>] [--image <file> ...]',
      '  pipeline verify shot --id <shotId> --version <n> [--model <m>] [--prompt <p> | --prompt-file <file>] [--image <file> ...] [--speech-audio <wav>] [--video <file> ...] [--audio <file> ...]',
      '  pipeline voice transcribe --audio <file> [--audio <file> ...] [--out <file>] | --dir <folder> [--engine whisper] [--model-file <path>] [--force]  # exact transcript sidecars for lip-sync prompts',
      '  pipeline credits report [--root <ep>] [--type <t> --name <n>] [--sheet <slug>] [--since <ISO>] [--until <ISO>] [--task <label>] [--by element|sheet|shot|day|model|task|kind] [--saved-only] [--json]',
      '  pipeline credits reconcile --since <ISO> [--until <ISO>] [--exclude-unbilled] [--json] [--root <dir>]',
      '  pipeline task [set <label> | show | clear] [--root <dir>]  # set/show/clear the active credit task for a project (a persistent --task fallback)',
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
