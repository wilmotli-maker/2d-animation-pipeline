// test/review-render.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderShotPage, renderImagePage } from '../src/review-render.js';

const shotModel = { type: 'shots', generatedAt: 'T', shots: [
  { shotId: 's1', episode: '1', characters: ['mira'], description: 'd', promotedVersion: 'v002', versions: [
    { version: 'v001', kind: 'draft', promoted: false, video: 'assets/s1/v001/output.mp4',
      variants: { alpha: null, upscaled: [], qc: [] }, meta: {} },
    { version: 'v002', kind: 'draft', promoted: true, video: 'assets/s1/v002/output.mp4',
      variants: { alpha: null, upscaled: [], qc: [] }, meta: { model: 'seedance_2_5' } }] }] };
const shotSel = { layout: 'side-by-side', versions: { s1: ['v001', 'v002'] } };

test('renderShotPage: embeds slug/type, marks controls, preserves hide/marker', () => {
  const html = renderShotPage({ model: shotModel, selection: shotSel, title: 'Shots', slug: 'ep1', type: 'shots' });
  assert.match(html, /<!doctype html>/i);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.match(html, /"slug": ?"ep1"/);            // slug embedded (namespaces storage/download)
  assert.match(html, /"type": ?"shots"/);
  assert.match(html, /review:marks:/);             // localStorage key prefix
  assert.match(html, /-marks\.json/);              // download filename
  assert.match(html, /class="markbox"/);           // per-version mark checkbox
  assert.match(html, /Show only marked/);
  assert.match(html, /Download marks/);
  assert.match(html, /Import marks/);
  assert.match(html, /no marked versions/);
  assert.match(html, /class="hide"/);              // preserved
  assert.match(html, /function hmark/);            // preserved
  assert.match(html, /"promotedVersion": ?"v002"/);
});

test('renderImagePage: embeds slug and marks controls', () => {
  const model = { type: 'images', generatedAt: 'T', characters: [
    { type: 'characters', name: 'mira', sheets: [
      { sheetType: 'pose', slug: 'a', versions: [
        { version: 'v001', images: ['assets/mira/pose/a/v001.png'], upscaled: [], meta: {} }] }] }] };
  const sel = { layout: 'side-by-side', versions: { 'mira/pose/a': ['v001'] } };
  const html = renderImagePage({ model, selection: sel, title: 'Sheets', slug: 'sh', type: 'images' });
  assert.match(html, /assets\/mira\/pose\/a\/v001\.png/);
  assert.match(html, /"slug": ?"sh"/);
  assert.match(html, /class="markbox"/);
  assert.match(html, /Show only marked/);
});
