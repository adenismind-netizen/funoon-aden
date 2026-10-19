'use strict';

const express = require('express');
const path = require('node:path');
const { Store } = require('./lib/store');
const { loadQuiz, validateSubmission } = require('./lib/validate');
const { makeProviders } = require('./lib/providers');
const { makeWorker } = require('./lib/worker');

const ORIGINAL_ORIGIN = 'https://adenismind-netizen.github.io';

function createService({ env = process.env, dbPath, now = Date.now, fetchImpl = fetch, providers, limits, log = () => {} } = {}) {
  if (env.ALLOWED_ORIGIN && env.ALLOWED_ORIGIN !== ORIGINAL_ORIGIN) throw new Error('unapproved_origin_configuration');
  const quiz = loadQuiz(env.QUIZ_SOURCE_DIR || path.resolve(__dirname, '..'));
  const store = new Store(dbPath || env.DB_PATH || path.join(env.DATA_DIR || path.join(__dirname, 'data'), 'quiz.db'), { now, hashKey: env.RATE_HASH_KEY, limits });
  const remote = makeProviders(env, fetchImpl);
  const worker = makeWorker(store, providers || remote.providers, { onEvent: log });
  const app = express();
  app.disable('x-powered-by');
  // Only the local nginx reverse proxy may set the client address.
  app.set('trust proxy', 'loopback');
  app.get('/health', (_req, res) => res.json({ ok: true, version: 2 }));

  app.use('/api/quiz-submit', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.vary('Origin');
    if (req.headers.origin !== ORIGINAL_ORIGIN) return res.status(403).json({ ok: false, error: 'forbidden' });
    res.set('Access-Control-Allow-Origin', ORIGINAL_ORIGIN);
    if (req.method === 'OPTIONS') {
      const requested = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
      if (req.headers['access-control-request-method'] !== 'POST' || requested.some(header => header !== 'content-type')) return res.status(403).json({ ok: false, error: 'forbidden' });
      res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.set('Access-Control-Max-Age', '600');
      return res.status(204).end();
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) return res.status(415).json({ ok: false, error: 'json_required' });
    next();
  });
  app.use('/api/quiz-submit', express.json({ limit: '4kb', strict: true, inflate: false }));
  app.post('/api/quiz-submit', (req, res) => {
    try {
      const submission = validateSubmission(req.body, quiz);
      if (submission.error) return res.status(400).json({ ok: false, error: submission.error });
      if (!providers && Object.values(remote.configured).some(value => !value)) return res.status(503).json({ ok: false, error: 'service_not_configured' });
      const result = store.accept(submission, req.ip || 'unknown');
      if (!result.accepted) {
        if (result.status === 429) res.set('Retry-After', result.error === 'phone_cooldown' ? '21600' : '3600');
        return res.status(result.status).json({ ok: false, error: result.error });
      }
      // This acknowledges the durable outbox only, not provider delivery.
      return res.status(202).json({ ok: true, accepted: true, submissionId: submission.payload.submissionId, state: 'queued' });
    } catch (_) {
      log({ event: 'submission_storage_error' });
      return res.status(503).json({ ok: false, error: 'temporarily_unavailable' });
    }
  });
  app.use((_req, res) => res.status(404).json({ ok: false, error: 'not_found' }));
  app.use((error, _req, res, _next) => {
    const status = error.type === 'entity.too.large' ? 413 : error.type === 'encoding.unsupported' ? 415 : 400;
    res.status(status).json({ ok: false, error: status === 413 ? 'too_large' : 'bad_request' });
  });
  return { app, store, worker, configured: remote.configured, close: async () => { await worker.stop(); store.close(); } };
}

if (require.main === module) {
  const log = event => console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
  const service = createService({ log });
  const port = Number(process.env.PORT || 3010);
  const server = service.app.listen(port, '127.0.0.1', () => log({ event: 'listening', port, configured: service.configured }));
  service.worker.start();
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    server.close();
    await service.close();
    process.exit(0);
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

module.exports = { createService, ORIGINAL_ORIGIN };
