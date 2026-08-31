// test/review-render.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderShotPage, renderImagePage } from '../src/review-render.js';

test('renderShotPage: self-contained, embeds model, references videos', () => {
  const model = { type: 'shots', shots: [
    { shotId: 's1', episode: '1', characters: ['mira'], description: 'd', versions: [
      { version: 'v002', kind: 'draft', video: 'assets/s1/v002/output.mp4',
        variants: { alpha: null, upscaled: [], qc: [] }, meta: { model: 'seedance_2_5' } },
      { version: 'final', kind: 'final', video: 'assets/s1/final/clip.mp4',
        variants: { alpha: null, upscaled: [], qc: [] }, meta: {} }] }] };
  const sel = { layout: 'side-by-side', versions: { s1: ['v002', 'final'] } };
  const html = renderShotPage({ model, selection: sel, title: 'Shots' });
  assert.match(html, /<!doctype html>/i);
  assert.doesNotMatch(html, /https?:\/\//);              // no external resources
  assert.match(html, /assets\/s1\/final\/clip\.mp4/);
  assert.match(html, /<script[^>]*id="review-data"[^>]*>/);
  assert.match(html, /"shotId": ?"s1"/);
});

test('renderImagePage: renders images and title', () => {
  const model = { type: 'images', characters: [
    { type: 'characters', name: 'mira', sheets: [
      { sheetType: 'pose', slug: 'a', versions: [
        { version: 'v001', images: ['assets/mira/pose/a/v001.png'], upscaled: [], meta: {} }] }] }] };
  const sel = { layout: 'side-by-side', versions: { 'mira/pose/a': ['v001'] } };
  const html = renderImagePage({ model, selection: sel, title: 'Sheets' });
  assert.match(html, /assets\/mira\/pose\/a\/v001\.png/);
  assert.match(html, /Sheets/);
});
