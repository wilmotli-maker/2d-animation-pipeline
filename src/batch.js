// Async batch engine. Verified backend behavior (sanity checks 6 & 7):
// `create` without --wait returns immediately with a job id, and the backend
// runs jobs in PARALLEL. So we submit the whole batch first, then poll all
// outstanding jobs together — real throughput, not serialized waits.

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
export async function runBatch(runner, requests, { pollIntervalMs = 4000, maxPolls = 900, maxGetErrors = 5 } = {}) {
  // Submission is sequential; each create call has spawn latency but is short
  // relative to generation time. Parallelize with a concurrency cap later if
  // large batches make submission time material.
  // 1) Submit everything async (wait:false) — do not block between submits.
  const jobs = [];
  for (const req of requests) {
    try {
      const res = await runner.generate(req.model, { ...req.opts, wait: false });
      jobs.push({ ref: req.ref, id: res.id, status: res.id ? 'submitted' : 'error',
        outputUrl: null, error: res.id ? undefined : 'submit returned no job id' });
    } catch (err) {
      jobs.push({ ref: req.ref, id: null, status: 'error', outputUrl: null, error: err.message });
    }
  }

  // 2) Poll all outstanding jobs together until each is terminal. Iterate the
  // job objects directly (not an id-keyed map) so duplicate ids can't orphan a
  // job and the timeout sweep covers every still-pending job.
  const isPending = (j) => j.status === 'submitted';
  let polls = 0;
  while (jobs.some(isPending) && polls < maxPolls) {
    for (const job of jobs) {
      if (!isPending(job)) continue;
      try {
        const r = await runner.get(job.id);
        job.getErrors = 0; // a clean read clears any transient-failure streak
        job.error = undefined; // and clears a stale transient message
        if (isTerminalStatus(r.status)) {
          job.status = r.status;
          job.outputUrl = r.outputUrl || null;
        }
      } catch (err) {
        // Transient CLI blip: keep the job pending and retry next poll. Only give
        // up after maxGetErrors CONSECUTIVE thrown gets.
        job.getErrors = (job.getErrors || 0) + 1;
        job.error = err.message;
        if (job.getErrors >= maxGetErrors) {
          job.status = 'error';
          job.error = `get failed ${job.getErrors}x consecutively: ${err.message}`;
        }
      }
    }
    polls += 1;
    if (jobs.some(isPending)) await sleep(pollIntervalMs);
  }
  for (const job of jobs) {
    if (isPending(job)) {
      job.status = 'error';
      job.error = 'timed out waiting for completion';
    }
  }
  return jobs;
}
