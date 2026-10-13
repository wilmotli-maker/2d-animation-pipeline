// Replay a shot's EXACT original inputs on HF, N times. Reads <draft>/output.json, resolves
// image refs against --root, re-uploads the local speech-ref video, and submits the exact
// prompt + settings. Reports each roll's status.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRunner } from '../../../../src/cli.js';
import { runBatch } from '../../../../src/batch.js';
import { downloadTo } from '../../../../src/download.js';
import { mkdir } from 'node:fs/promises';
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const draft = arg('draft'); const root = arg('root'); const rolls = Number(arg('rolls', 3));
const j = JSON.parse(await readFile(path.join(draft, 'output.json'), 'utf8'));
const imgs = (j.imageReferences || []).map((p) => path.isAbsolute(p) ? p : path.join(root, p));
const vids = (j.videoReferences || []).map((p) => path.isAbsolute(p) ? p : path.join(root, p));
const runner = createRunner();
console.log(`replay ${path.basename(path.dirname(path.dirname(draft)))}/${path.basename(draft)} | ${j.model} ${j.resolution} ${j.duration}s ${j.aspectRatio} genAudio=${j.generateAudio} ${j.mode} | ${imgs.length} img + ${vids.length} vid`);
const vidIds = [];
for (const v of vids) { const u = await runner.upload(v); vidIds.push(u.id); }
const opts = { prompt: j.prompt, imageReferences: imgs, videoReferences: vidIds, resolution: j.resolution, duration: j.duration, aspectRatio: j.aspectRatio, generateAudio: j.generateAudio, mode: j.mode };
if (arg('draft-on') != null) { opts.extraArgs = ['--draft', 'true']; console.log('  (draft mode ON)'); }
const results = [];
for (let i = 1; i <= rolls; i++) {
  const [r] = await runBatch(runner, [{ ref: `roll${i}`, model: j.model, opts }]);
  results.push(r.status);
  if (r.status==='completed' && r.outputUrl && arg('save')) { await mkdir(arg('save'),{recursive:true}); await downloadTo(r.outputUrl, arg('save')+'/roll'+i+'.mp4'); console.log('    saved roll'+i+'.mp4'); }
  console.log(`  roll ${i}: ${r.status}${r.outputUrl ? ' ✓' : ''}${r.error ? ' — ' + r.error : ''}`);
}
const ok = results.filter((s) => s === 'completed').length;
console.log(`RESULT: ${ok}/${rolls} passed  [${results.join(', ')}]`);
