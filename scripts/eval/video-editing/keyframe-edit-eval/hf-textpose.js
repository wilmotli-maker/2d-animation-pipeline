#!/usr/bin/env node
// HF text-pose targeted edit: start_image + end_image (first/last frames) + speech-ref video,
// pose described in the prompt (no pose keyframe image). N rolls, optional --draft-on to use the
// moderation-bypassing draft path. Uploads the video first (inline video upload can hang).
//
//   node hf-textpose.js --prompt-file <p.md> --first <a.png> --last <b.png> --video <speech.mp4> \
//     --out <dir> [--duration 4] [--rolls 2] [--draft-on 1]

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRunner } from '../../../../src/cli.js';
import { runBatch } from '../../../../src/batch.js';
import { downloadTo } from '../../../../src/download.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };

async function main() {
  const promptFile = arg('prompt-file'); const first = arg('first'); const last = arg('last');
  const video = arg('video'); const out = arg('out'); const duration = Number(arg('duration', 4));
  const rolls = Number(arg('rolls', 1)); const rollStart = Number(arg('roll-start', 1)); const draftOn = arg('draft-on') != null;
  if (!promptFile || !first || !last || !video || !out) { console.error('need --prompt-file --first --last --video --out'); process.exit(2); }
  await mkdir(out, { recursive: true });
  const prompt = (await readFile(promptFile, 'utf8')).trim();
  const runner = createRunner();
  const vid = await runner.upload(video);
  const opts = {
    prompt, startImage: first, endImage: last, videoReferences: [vid.id],
    resolution: '480p', duration, aspectRatio: '3:4', generateAudio: true, mode: 'omni_reference',
  };
  if (draftOn) opts.extraArgs = ['--draft', 'true'];
  console.log(`${path.basename(path.dirname(path.dirname(path.dirname(out))))} | start/end + speech${draftOn ? ' | DRAFT' : ''} | ${rolls} roll(s)`);
  const results = [];
  for (let i = rollStart; i < rollStart + rolls; i++) {
    const [r] = await runBatch(runner, [{ ref: `roll${i}`, model: 'seedance_2_5', opts }]);
    results.push(r.status);
    if (r.status === 'completed' && r.outputUrl) { await downloadTo(r.outputUrl, path.join(out, `roll${i}.mp4`)); console.log(`  roll ${i}: completed ✓ -> roll${i}.mp4`); }
    else console.log(`  roll ${i}: ${r.status}${r.error ? ' — ' + r.error : ''}`);
  }
  const ok = results.filter((s) => s === 'completed').length;
  console.log(`RESULT: ${ok}/${rolls} [${results.join(', ')}]`);
}
main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
