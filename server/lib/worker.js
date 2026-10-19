'use strict';

function makeWorker(store, providers, { onEvent = () => {} } = {}) {
  let timer = null;
  const active = new Set();
  let stopped = false;

  async function processKind(kind) {
    if (active.has(kind) || stopped) return;
    active.add(kind);
    try {
      const job = store.claim(kind);
      if (!job) return;
      let outcome;
      try { outcome = await providers[kind](job.submission); }
      catch (error) {
        const state = ['failed', 'queued', 'unknown'].includes(error.state) ? error.state : 'unknown';
        outcome = { state, code: /^[a-z0-9_]{1,80}$/.test(error.code || '') ? error.code : 'provider_outcome_unknown', retryMs: error.retryMs };
        if (state === 'queued') {
          const safeSaveDns = kind === 'save' && error.code === 'dns_unavailable';
          const maxAttempts = safeSaveDns ? 24 : 4;
          if (job.attempts >= maxAttempts) outcome = { state: 'failed', code: safeSaveDns ? 'dns_retry_exhausted' : 'rate_retry_exhausted' };
          else outcome.retryMs = Math.max(1000, Math.min(Number(error.retryMs) || 60000, 3600000));
        }
      }
      store.finish(job, outcome);
      onEvent({ event: 'job_' + outcome.state, kind, code: outcome.code || null });
    } finally { active.delete(kind); }
  }

  async function tick() {
    if (stopped) return;
    // Providers progress independently; one unavailable provider cannot block another.
    await Promise.all(['save', 'telegram', 'whatsapp'].map(processKind));
  }

  function start() {
    if (timer) return;
    stopped = false;
    const safeTick = () => tick().catch(() => onEvent({ event: 'worker_error' }));
    timer = setInterval(safeTick, 500); timer.unref(); safeTick();
  }

  async function stop() {
    stopped = true; if (timer) clearInterval(timer); timer = null;
    // Fetch timeout is 10s. Finish in-flight DB transitions before closing SQLite.
    while (active.size) await new Promise(resolve => setTimeout(resolve, 25));
  }
  return { tick, start, stop };
}

module.exports = { makeWorker };
