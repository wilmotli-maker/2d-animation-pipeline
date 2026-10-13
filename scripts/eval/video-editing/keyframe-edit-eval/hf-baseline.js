// HF baseline: the standard ArtAI recipe — ONE image_reference + speech-ref video + audio.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRunner } from '../../../../src/cli.js';
import { runBatch } from '../../../../src/batch.js';
import { downloadTo } from '../../../../src/download.js';
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const prompt = (await readFile(arg('prompt-file'), 'utf8')).trim();
const out = arg('out'); await mkdir(out, { recursive: true });
const runner = createRunner();
console.log('uploading speech video…');
const vid = await runner.upload(arg('video'));
const opts = { prompt, imageReferences: [arg('image')], videoReferences: [vid.id], resolution: '480p', duration: Number(arg('duration', 4)), aspectRatio: '3:4', generateAudio: true, mode: 'omni_reference' };
console.log('submitting (1 image_reference + speech video)…');
const [res] = await runBatch(runner, [{ ref: 'hf-baseline', model: 'seedance_2_5', opts }]);
await writeFile(path.join(out, 'result.json'), JSON.stringify(res, null, 2) + '\n');
if (res.status !== 'completed' || !res.outputUrl) { console.error(`HF status: ${res.status}${res.error ? ' — ' + res.error : ''}`); process.exit(1); }
await downloadTo(res.outputUrl, path.join(out, 'output.mp4'));
console.log(`done -> ${path.join(out, 'output.mp4')}`);
