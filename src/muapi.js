// MuAPI (muapi.ai) generation runner for Seedance 2.5 — a second backend alongside the
// higgsfield runner (src/cli.js). Same duck-typed interface the batch engine + generate.js
// use: generate(model, opts) -> { id }, get(id) -> { status, outputUrl }, estimateCost().
//
// Why a second runner: higgsfield's packaging deterministically blocks the keyframe-edit +
// speech-ref combo as nsfw; the direct MuAPI/Seedance API runs it fine. See the keyframe-edit
// eval + docs/recipes.
//
// Reference handling: MuAPI takes PUBLIC URLs only, in separate typed arrays
// (images_list / videos_list / audios_list) — no cross-array ordering. Local file paths are
// uploaded to fal storage first (we already carry FAL_KEY). Reference ROLE/order is expressed
// with @Image1../@Video1 tags in the prompt (the caller's prompt), not by the API.

import { readFile } from 'node:fs/promises';

const MUAPI_BASE = 'https://api.muapi.ai/api/v1';
const FAL_INITIATE = 'https://rest.alpha.fal.ai/storage/upload/initiate';

// per-second USD pricing by resolution tier (muapi.ai, Seedance 2.5).
const RATE_PER_SEC = { '480p': 0.17, '720p': 0.34, '1080p': 0.85, '4k': 1.70, '4K': 1.70 };

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
};
const extOf = (p) => { const i = String(p).lastIndexOf('.'); return i < 0 ? '' : String(p).slice(i).toLowerCase(); };
const isUrl = (s) => /^https?:\/\//i.test(String(s));

export class MuapiError extends Error {
  constructor(message, { status, body } = {}) { super(message); this.name = 'MuapiError'; this.status = status; this.body = body; }
}

// mode -> MuAPI route base. Omni Reference is the default whenever refs are present.
function routeBase(mode, { hasImages, hasVideos }) {
  if (mode === 'video_edit') return 'video-edit';
  if (mode === 'video_extension') return 'video-extend';
  if (hasImages || hasVideos) return 'omni-reference';
  return 'text-to-video';
}
// 720p is the unsuffixed route; others take a -<res> suffix.
function routeFor({ mode, spicy, resolution, hasImages, hasVideos }) {
  const base = routeBase(mode, { hasImages, hasVideos });
  const res = String(resolution || '720p').toLowerCase();
  const suffix = res === '720p' ? '' : `-${res}`;
  return `seedance-2.5-${spicy ? 'spicy-' : ''}${base}${suffix}`;
}

// Default fal-storage uploader: returns a public URL for a local file.
function makeFalUploader(falKey, fetchImpl) {
  return async function upload(file) {
    if (!falKey) throw new MuapiError(`FAL_KEY required to upload local input: ${file}`);
    const ct = MIME[extOf(file)] || 'application/octet-stream';
    const init = await fetchImpl(FAL_INITIATE, {
      method: 'POST', headers: { Authorization: `Key ${falKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content_type: ct, file_name: String(file).split('/').pop() }),
    });
    if (!init.ok) throw new MuapiError(`fal initiate ${init.status}: ${(await init.text()).slice(0, 200)}`, { status: init.status });
    const { file_url, upload_url } = JSON.parse(await init.text());
    const put = await fetchImpl(upload_url, { method: 'PUT', headers: { 'Content-Type': ct }, body: await readFile(file) });
    if (!put.ok) throw new MuapiError(`fal PUT ${put.status}`, { status: put.status });
    return file_url;
  };
}

function extractOutputUrl(j) {
  return (Array.isArray(j?.outputs) ? j.outputs[0] : null)
    || j?.output?.video?.url || j?.video?.url || j?.result?.video_url || j?.video_url || null;
}
// MuAPI status -> the batch engine's vocabulary. 'processing'/'pending'/'queued' stay
// non-terminal; anything else terminal (completed, or a failure/moderation verdict).
function mapStatus(s) {
  const t = String(s || '').toLowerCase();
  if (['completed', 'succeeded', 'success'].includes(t)) return 'completed';
  if (['pending', 'processing', 'queued', 'in_progress', 'running', 'starting'].includes(t)) return 'processing';
  return t || 'failed'; // failed/error/nsfw/moderated/… -> terminal (matches batch FAILURE_RE)
}

export function createMuapiRunner({
  apiKey = process.env.MUAPI_KEY,
  falKey = process.env.FAL_KEY,
  spicy = false,
  resolution = '480p',
  fetchImpl = globalThis.fetch,
  uploadFile,            // injectable (tests); defaults to fal storage
} = {}) {
  if (!fetchImpl) throw new MuapiError('global fetch unavailable and no fetchImpl provided');
  const upload = uploadFile || makeFalUploader(falKey, fetchImpl);
  const toUrl = async (ref) => (isUrl(ref) ? ref : upload(ref));
  const headers = () => ({ 'x-api-key': apiKey, 'Content-Type': 'application/json' });

  async function buildBody(opts) {
    const images = opts.imageReferences || [];
    const videos = opts.videoReferences || [];
    const audios = opts.audioReferences || [];
    const res = opts.resolution || resolution;
    const route = routeFor({ mode: opts.mode, spicy, resolution: res, hasImages: images.length, hasVideos: videos.length });

    const images_list = []; for (const r of images) images_list.push(await toUrl(r));
    const videos_list = []; for (const r of videos) videos_list.push(await toUrl(r));
    const audios_list = []; for (const r of audios) audios_list.push(await toUrl(r));

    const body = { prompt: opts.prompt };
    if (opts.aspectRatio != null) body.aspect_ratio = opts.aspectRatio;
    if (opts.duration != null) body.duration = Number(opts.duration);
    if (opts.generateAudio != null) body.generate_audio = !!opts.generateAudio;

    if (route.includes('video-edit') || route.includes('video-extend')) {
      if (videos_list.length) body.video = videos_list[0];           // the source clip to edit
      if (images_list.length) body.reference_images = images_list;   // optional identity refs
      if (audios_list.length) body.reference_audios = audios_list;
    } else {
      if (images_list.length) body.images_list = images_list;
      if (videos_list.length) body.videos_list = videos_list;
      if (audios_list.length) body.audios_list = audios_list;
    }
    return { route, body };
  }

  return {
    // Submit a job (async). Returns { id } like the higgsfield runner; the batch engine polls get().
    async generate(model, opts = {}) {
      if (!apiKey) throw new MuapiError('MUAPI_KEY is not set');
      const { route, body } = await buildBody(opts);
      const res = await fetchImpl(`${MUAPI_BASE}/${route}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
      const text = await res.text();
      if (!res.ok) throw new MuapiError(`muapi ${route} submit failed (HTTP ${res.status}): ${text.slice(0, 300)}`, { status: res.status, body: text });
      let j; try { j = JSON.parse(text); } catch { throw new MuapiError(`muapi ${route}: response not JSON: ${text.slice(0, 200)}`); }
      const id = j.request_id || j.id;
      if (!id) throw new MuapiError(`muapi ${route}: no request_id in response: ${text.slice(0, 200)}`);
      return { id, status: 'submitted' };
    },

    // Poll one job. Returns { id, status, outputUrl, error }.
    async get(jobId) {
      const res = await fetchImpl(`${MUAPI_BASE}/predictions/${jobId}/result`, { headers: headers() });
      const text = await res.text();
      if (!res.ok) throw new MuapiError(`muapi result ${jobId} (HTTP ${res.status}): ${text.slice(0, 200)}`, { status: res.status });
      let j; try { j = JSON.parse(text); } catch { throw new MuapiError(`muapi result ${jobId}: response not JSON: ${text.slice(0, 200)}`); }
      const status = mapStatus(j.status);
      return { id: jobId, status, outputUrl: status === 'completed' ? extractOutputUrl(j) : null, error: j.error ?? j.detail ?? null };
    },

    async waitFor(jobId, { intervalMs = 5000, maxMs = 15 * 60 * 1000 } = {}) {
      const start = Date.now();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const r = await this.get(jobId);
        if (r.status === 'completed' || !['processing'].includes(r.status)) return r;
        if (Date.now() - start > maxMs) return { id: jobId, status: 'error', outputUrl: null, error: 'muapi wait timed out' };
        await new Promise((r2) => setTimeout(r2, intervalMs));
      }
    },

    // USD cost estimate (duration x per-second rate by resolution). Unit is dollars, not HF
    // credits — recorded as source 'api' by the credit layer. Returns null if indeterminate.
    async estimateCost(_model, opts = {}) {
      const res = String(opts.resolution || resolution || '480p').toLowerCase();
      const rate = RATE_PER_SEC[res] ?? RATE_PER_SEC['480p'];
      const dur = Number(opts.duration);
      if (!Number.isFinite(dur) || dur <= 0) return null;
      return Math.round(rate * dur * 100) / 100;
    },

    async upload(filePath) { const url = await toUrl(String(filePath)); return { id: url, type: null, url }; },
  };
}
