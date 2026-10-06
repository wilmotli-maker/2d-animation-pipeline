#!/usr/bin/env node
// Build the review page for the keyframe-edit eval. Each row = shot x edit-position; versions:
//   v001 source · v002 kf5 raw · v003 kf5 spliced · v004 nu raw · v005 nu spliced
// Then inject a still of the edited pose as the leading cell of each row (a post-step; the
// pipeline review tool renders only videos, so this is done on the output HTML). No credits.
//
//   node review-build.js

import { spawn } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE = path.join(C.REPO_ROOT, 'bin', 'pipeline.js');
const REVIEW = path.join(C.EVAL_ROOT, 'review');
const SLUG = 'keyframe-edit';

const rawPath = (id) => path.join(C.SCRATCH, 'shots', id, 'drafts', 'v001', 'output.mp4');
const splPath = (shot, variant, pos) => path.join(C.caseDir(C.EVAL_ROOT, shot, variant, pos), 'spliced.mp4');

function run(bin, args) {
  return new Promise((res, rej) => {
    const c = spawn(bin, args, { stdio: 'inherit' });
    c.on('close', (code) => (code === 0 ? res() : rej(new Error(`${bin} exit ${code}`))));
  });
}

// pose still per shot+position, keyed by review shotId (<shot>-<pos>)
const poseStillFor = {};
function buildProject() {
  let made = 0;
  for (const s of C.SHOTS) for (const pos of C.POSITIONS) {
    const id = `${s.shot}-${pos}`;
    const layers = [
      ['v001', path.join(C.EVAL_ROOT, 'sources', `${s.shot}.mp4`)],
      ['v002', rawPath(`${s.shot}__kf5__${pos}`)],
      ['v003', splPath(s.shot, 'kf5', pos)],
      ['v004', rawPath(`${s.shot}__nu__${pos}`)],
      ['v005', splPath(s.shot, 'nu', pos)],
    ];
    if (!layers.slice(1).some(([, f]) => existsSync(f))) continue;
    for (const [v, f] of layers) {
      if (!existsSync(f)) continue;
      const d = path.join(REVIEW, 'shots', id, 'drafts', v);
      mkdirSync(d, { recursive: true });
      copyFileSync(f, path.join(d, 'output.mp4'));
      made++;
    }
    writeFileSync(path.join(REVIEW, 'shots', id, 'shot.yaml'),
      `shotId: ${id}\ndescription: "${s.shot} — ${pos}-frame edit (${s.edits[pos]}). v001 source · v002 kf5 raw · v003 kf5 spliced · v004 nu raw · v005 nu spliced."\nduration: 4\nelements: []\n`);
    poseStillFor[id] = path.join(C.EVAL_ROOT, s.shot, 'poses', `${pos}-${s.edits[pos]}.png`);
  }
  return made;
}

function injectStills(pageDir) {
  const stillDir = path.join(pageDir, 'assets', 'pose-stills');
  mkdirSync(stillDir, { recursive: true });
  const map = {};
  for (const [id, still] of Object.entries(poseStillFor)) {
    if (!existsSync(still)) continue;
    const rel = path.join('assets', 'pose-stills', `${id}.png`);
    copyFileSync(still, path.join(pageDir, rel));
    map[id] = rel;
  }
  const idx = path.join(pageDir, 'index.html');
  let html = readFileSync(idx, 'utf8');
  const marker = '<!--pose-still-inject-->';
  if (html.includes(marker)) return; // idempotent
  const snippet = `
${marker}
<style>
  .cols .col.pose-still img { width: 100%; border-radius: 6px; display: block; }
  .cols .col.pose-still .v { font-style: italic; }
</style>
<script>
(function () {
  var STILLS = ${JSON.stringify(map)};
  function inject() {
    document.querySelectorAll('.cols[data-row]').forEach(function (row) {
      var id = row.getAttribute('data-row');
      if (!STILLS[id] || row.querySelector('.col.pose-still')) return;
      var col = document.createElement('div');
      col.className = 'col pose-still';
      col.innerHTML = '<div class="vrow"><span class="v">edited pose</span></div>'
        + '<img src="' + STILLS[id] + '" loading="lazy">'
        + '<div class="m">injected keyframe (reference)</div>';
      row.insertBefore(col, row.firstChild);
    });
  }
  var mo = new MutationObserver(function () { inject(); });
  mo.observe(document.body, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', inject);
  inject();
})();
</script>`;
  html = html.replace('</body>', snippet + '\n</body>');
  writeFileSync(idx, html);
}

const made = buildProject();
console.log(`review project: ${made} version-clips`);
await run('node', [PIPELINE, 'review', 'shots', '--slug', SLUG, '--root', REVIEW,
  '--title', 'Keyframe-edit eval — pose still · source · kf5 raw/spliced · nu raw/spliced', '--update']);
injectStills(path.join(REVIEW, 'web', SLUG));
console.log(`injected pose stills -> ${path.join(REVIEW, 'web', SLUG, 'index.html')}`);
