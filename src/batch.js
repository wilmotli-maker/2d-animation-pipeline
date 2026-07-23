// Async batch engine. Verified backend behavior (sanity checks 6 & 7):
// `create` without --wait returns immediately with a job id, and the backend
// runs jobs in PARALLEL. So we submit the whole batch first, then poll all
// outstanding jobs together — real throughput, not serialized waits.

const FAILURE_RE = /fail|error|cancel/i;

export function isTerminalStatus(status) {
  if (typeof status !== 'string') return false;
  return status === 'completed' || FAILURE_RE.test(status);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// requests: [{ ref, model, opts }]  (opts are createRunner.generate options)
// Returns one result per request, order preserved:
//   { ref, id, status, outputUrl, error? }
export async function runBatch(runner, requests, { pollIntervalMs = 4000, maxPolls = 900 } = {}) {
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

  // 2) Poll all outstanding jobs together until each is terminal.
  const pending = new Map(jobs.filter((j) => j.id && j.status === 'submitted').map((j) => [j.id, j]));
  let polls = 0;
  while (pending.size && polls < maxPolls) {
    for (const [id, job] of [...pending]) {
      let r;
      try {
        r = await runner.get(id);
      } catch (err) {
        job.status = 'error';
        job.error = err.message;
        pending.delete(id);
        continue;
      }
      if (isTerminalStatus(r.status)) {
        job.status = r.status;
        job.outputUrl = r.outputUrl || null;
        pending.delete(id);
      }
    }
    polls += 1;
    if (pending.size) await sleep(pollIntervalMs);
  }
  for (const job of pending.values()) {
    job.status = 'error';
    job.error = 'timed out waiting for completion';
  }
  return jobs;
}
