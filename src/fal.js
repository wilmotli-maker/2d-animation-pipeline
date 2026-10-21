// fal.ai generation runner for Seedance 2.5 — a third backend alongside the higgsfield (src/cli.js)
// and MuAPI (src/muapi.js) runners. Same duck-typed interface the batch engine + generate.js use:
// generate(model, opts) -> { id }, get(id) -> { status, outputUrl }, estimateCost(), upload().
//
// fal hits bytedance/seedance-2.5/reference-to-video natively: no moderation, cheapest at 480p, and
// image/audio references are free (video refs are billed). Local files are uploaded to fal storage
// first. Reference ROLE/order is expressed with @Image1../@Video1 tags in the caller's prompt (fal
// addresses references by position), not by the API.
import { readFile } from 'node:fs/promises';

const QUEUE = 'https://queue.fal.run/bytedance/seedance-2.5/reference-to-video';
const FAL_INITIATE = 'https://rest.alpha.fal.ai/storage/upload/initiate';

// per-second USD pricing by resolution tier (Seedance 2.5), matching the MuAPI runner.
const RATE_PER_SEC = { '480p': 0.17, '720p': 0.34, '1080p': 0.85, '4k': 1.70, '4K': 1.70 };

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
};
const extOf = (p) => { const i = String(p).lastIndexOf('.'); return i < 0 ? '' : String(p).slice(i).toLowerCase(); };
const isUrl = (s) => /^https?:\/\//i.test(String(s));

export class FalError extends Error {
  constructor(message, { status, body } = {}) { super(message); this.name = 'FalError'; this.status = status; this.body = body; }
}

function makeFalUploader(falKey, fetchImpl) {
  return async function upload(file) {
    if (!falKey) throw new FalError(`FAL_KEY required to upload local input: ${file}`);
    const ct = MIME[extOf(file)] || 'application/octet-stream';
    const init = await fetchImpl(FAL_INITIATE, {
      method: 'POST', headers: { Authorization: `Key ${falKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content_type: ct, file_name: String(file).split('/').pop() }),
    });
    if (!init.ok) throw new FalError(`fal initiate ${init.status}: ${(await init.text()).slice(0, 200)}`, { status: init.status });
    const { file_url, upload_url } = JSON.parse(await init.text());
    const put = await fetchImpl(upload_url, { method: 'PUT', headers: { 'Content-Type': ct }, body: await readFile(file) });
    if (!put.ok) throw new FalError(`fal PUT ${put.status}`, { status: put.status });
    return file_url;
  };
}

function extractOutputUrl(j) {
  return j?.video?.url || j?.outputs?.[0]?.url || j?.output?.video?.url
    || (Array.isArray(j?.outputs) ? j.outputs[0] : null) || null;
}
// fal queue status -> the batch engine's vocabulary.
function mapStatus(s) {
  const t = String(s || '').toUpperCase();
  if (t === 'COMPLETED') return 'completed';
  if (['IN_QUEUE', 'IN_PROGRESS', 'PENDING', 'PROCESSING', 'QUEUED'].includes(t)) return 'processing';
  return (t || 'FAILED').toLowerCase(); // failed/error/… -> terminal (matches batch FAILURE_RE)
}

export function createFalRunner({
  falKey = process.env.FAL_KEY,
  resolution = '480p',
  fetchImpl = globalThis.fetch,
  uploadFile,            // injectable (tests); defaults to fal storage
} = {}) {
  if (!fetchImpl) throw new FalError('global fetch unavailable and no fetchImpl provided');
  const upload = uploadFile || makeFalUploader(falKey, fetchImpl);
  const toUrl = async (ref) => (isUrl(ref) ? ref : upload(ref));
  const auth = () => ({ Authorization: `Key ${falKey}` });
  const urls = new Map(); // request_id -> { statusUrl, responseUrl }

  async function buildBody(opts) {
    const res = String(opts.resolution || resolution).toLowerCase();
    const image_urls = []; for (const r of (opts.imageReferences || [])) image_urls.push(await toUrl(r));
    const video_urls = []; for (const r of (opts.videoReferences || [])) video_urls.push(await toUrl(r));
    const audio_urls = []; for (const r of (opts.audioReferences || [])) audio_urls.push(await toUrl(r));
    const body = { prompt: opts.prompt, resolution: res, task: 'reference' };
    if (opts.aspectRatio != null) body.aspect_ratio = opts.aspectRatio;
    if (opts.duration != null) body.duration = String(opts.duration); // fal duration is a STRING
    if (opts.generateAudio != null) body.generate_audio = !!opts.generateAudio;
    if (opts.draft) body.draft = true;
    if (image_urls.length) body.image_urls = image_urls;
    if (video_urls.length) body.video_urls = video_urls;
    if (audio_urls.length) body.audio_urls = audio_urls;
    return body;
  }

  return {
    async generate(_model, opts = {}) {
      if (!falKey) throw new FalError('FAL_KEY is not set');
      const body = await buildBody(opts);
      const res = await fetchImpl(QUEUE, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const text = await res.text();
      if (!res.ok) throw new FalError(`fal submit failed (HTTP ${res.status}): ${text.slice(0, 300)}`, { status: res.status, body: text });
      let j; try { j = JSON.parse(text); } catch { throw new FalError(`fal submit: response not JSON: ${text.slice(0, 200)}`); }
      const id = j.request_id;
      if (!id) throw new FalError(`fal submit: no request_id: ${text.slice(0, 200)}`);
      urls.set(id, { statusUrl: j.status_url || `${QUEUE}/requests/${id}/status`, responseUrl: j.response_url || `${QUEUE}/requests/${id}` });
      return { id, status: 'submitted' };
    },

    async get(jobId) {
      const u = urls.get(jobId) || { statusUrl: `${QUEUE}/requests/${jobId}/status`, responseUrl: `${QUEUE}/requests/${jobId}` };
      const st = await fetchImpl(u.statusUrl, { headers: auth() });
      const stText = await st.text();
      if (!st.ok) throw new FalError(`fal status ${jobId} (HTTP ${st.status}): ${stText.slice(0, 200)}`, { status: st.status });
      const stj = stText ? JSON.parse(stText) : {};
      const status = mapStatus(stj.status);
      if (status !== 'completed') return { id: jobId, status, outputUrl: null, error: stj.error ?? null };
      const rr = await fetchImpl(u.responseUrl, { headers: auth() });
      const j = JSON.parse(await rr.text());
      return { id: jobId, status: 'completed', outputUrl: extractOutputUrl(j), error: null };
    },

    async waitFor(jobId, { intervalMs = 5000, maxMs = 15 * 60 * 1000 } = {}) {
      const start = Date.now();
      for (;;) {
        const r = await this.get(jobId);
        if (r.status !== 'processing') return r;
        if (Date.now() - start > maxMs) return { id: jobId, status: 'error', outputUrl: null, error: 'fal wait timed out' };
        await new Promise((r2) => setTimeout(r2, intervalMs));
      }
    },

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
