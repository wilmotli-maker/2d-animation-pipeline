// test/review-render.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderShotPage, renderImagePage } from '../src/review-render.js';

test('renderShotPage: self-contained, embeds model, hide controls, promoted label', () => {
  const model = { type: 'shots', shots: [
    { shotId: 's1', episode: '1', characters: ['mira'], description: 'd', promotedVersion: 'v002', versions: [
      { version: 'v001', kind: 'draft', promoted: false, video: 'assets/s1/v001/output.mp4',
        variants: { alpha: null, upscaled: [], qc: [] }, meta: {} },
      { version: 'v002', kind: 'draft', promoted: true, video: 'assets/s1/v002/output.mp4',
        variants: { alpha: null, upscaled: [], qc: [] }, meta: { model: 'seedance_2_5' } }] }] };
  const sel = { layout: 'side-by-side', versions: { s1: ['v001', 'v002'] } };
  const html = renderShotPage({ model, selection: sel, title: 'Shots' });
  assert.match(html, /<!doctype html>/i);
  assert.doesNotMatch(html, /https?:\/\//);              // no external resources
  assert.match(html, /assets\/s1\/v002\/output\.mp4/);
  assert.match(html, /<script[^>]*id="review-data"[^>]*>/);
  assert.match(html, /"shotId": ?"s1"/);
  assert.match(html, /class="hide"/);                    // per-version hide control
  assert.match(html, /function hmark/);                  // hidden-version marker (unhide on click)
  assert.match(html, /"promotedVersion": ?"v002"/);      // promoted label source
});

test('renderShotPage: malicious description is escaped, not rendered as literal HTML', () => {
  const model = { type: 'shots', shots: [
    { shotId: 's1', episode: '1', characters: ['mira'], description: '<img src=x onerror=alert(1)>', versions: [
      { version: 'v001', kind: 'draft', video: 'assets/s1/v001/output.mp4',
        variants: { alpha: null, upscaled: [], qc: [] }, meta: {} }] }] };
  const sel = { layout: 'side-by-side', versions: { s1: ['v001'] } };
  const html = renderShotPage({ model, selection: sel, title: 'Shots' });
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.match(html, /\\u003cimg src=x onerror/);
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
