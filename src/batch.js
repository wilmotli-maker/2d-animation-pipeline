// Async batch engine. Verified backend behavior (sanity checks 6 & 7):
// `create` without --wait returns immediately with a job id, and the backend
// runs jobs in PARALLEL. We drive up to `concurrency` jobs at once through a
// worker pool: each worker submits its job async then polls it to a terminal
// status before pulling the next — real throughput, capped so a large batch
// doesn't flood the backend or the flaky CLI. A single job's failure (or
// timeout) stays isolated to that job and never blocks the others.

// Moderation verdicts (nsfw / moderated / content_moderation / rejected) are
// TERMINAL failures — the backend emits them once and never advances. Omitting
// them here made such jobs poll until maxPolls (~1h). See docs/recipes.
const FAILURE_RE = /fail|error|cancel|nsfw|moder|reject/i;

export function isTerminalStatus(status) {
  if (typeof status !== 'string') return false;
  return status === 'completed' || FAILURE_RE.test(status);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// requests: [{ ref, model, opts }]  (opts are createRunner.generate options)
// Returns one result per request, order preserved:
//   { ref, id, status, outputUrl, error? }
// The higgsfield CLI is flaky under rapid polling: a `generate get` can come
// back with empty/garbage stdout (parses to status 'unknown' — handled below by
// simply polling again) OR exit non-zero so `runner.get` THROWS. A thrown get is
// almost always transient (the very next poll succeeds), so we must NOT treat one
// as a permanent job failure — that was silently killing healthy jobs mid-run.
// Tolerate up to maxGetErrors CONSECUTIVE thrown gets per job (reset on any
// success) before declaring the job errored; a genuinely broken id exhausts the
// budget and still fails.
export async function runBatch(runner, requests, {
  pollIntervalMs = 4000, maxPolls = 900, maxGetErrors = 5, concurrency = 8,
} = {}) {
  // One slot per request, indexed by position so results stay in request order
  // regardless of which job finishes first. Iterating job objects (not an
  // id-keyed map) also means duplicate ids can't orphan a job.
  const jobs = requests.map((req) => ({
    ref: req.ref, id: null, status: 'pending', outputUrl: null, error: undefined,
  }));

  // Submit one job async (wait:false), then poll it alone until it reaches a
  // terminal status, times out, or exhausts its transient-error budget.
  async function runOne(req, job) {
    try {
      const res = await runner.generate(req.model, { ...req.opts, wait: false });
      if (!res.id) { job.status = 'error'; job.error = 'submit returned no job id'; return; }
      job.id = res.id;
      job.status = 'submitted';
    } catch (err) {
      job.status = 'error';
      job.error = err.message;
      return;
    }

    let polls = 0;
    let getErrors = 0;
    while (job.status === 'submitted' && polls < maxPolls) {
      try {
        const r = await runner.get(job.id);
        getErrors = 0;        // a clean read clears any transient-failure streak
        job.error = undefined; // and clears a stale transient message
        if (isTerminalStatus(r.status)) {
          job.status = r.status;
          job.outputUrl = r.outputUrl || null;
          break;
        }
      } catch (err) {
        // Transient CLI blip: keep the job pending and retry next poll. Only give
        // up after maxGetErrors CONSECUTIVE thrown gets.
        getErrors += 1;
        job.error = err.message;
        if (getErrors >= maxGetErrors) {
          job.status = 'error';
          job.error = `get failed ${getErrors}x consecutively: ${err.message}`;
          break;
        }
      }
      polls += 1;
      if (job.status === 'submitted') await sleep(pollIntervalMs);
    }
    if (job.status === 'submitted') {
      job.status = 'error';
      job.error = 'timed out waiting for completion';
    }
  }

  // Worker pool: at most `concurrency` jobs in flight at once. Each worker pulls
  // the next unclaimed request, runs it to terminal, then pulls the next.
  let next = 0;
  async function worker() {
    while (next < requests.length) {
      const i = next++;
      await runOne(requests[i], jobs[i]);
    }
  }
  const width = Math.max(1, Math.min(concurrency, requests.length));
  await Promise.all(Array.from({ length: width }, () => worker()));

  return jobs;
}
