'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createService, ORIGINAL_ORIGIN } = require('../server');
const { loadQuiz, validateSubmission } = require('../lib/validate');
const { Store } = require('../lib/store');
const { makeProviders, ProviderError } = require('../lib/providers');
const { makeWorker } = require('../lib/worker');

const quiz = loadQuiz();
const env = {
  QUIZ_SOURCE_DIR: process.env.QUIZ_SOURCE_DIR || path.resolve(__dirname, '../..'),
  TG_TOKEN: 'test-token', TG_CHAT: 'fixed-admin-chat', WASENDER_API_KEY: 'test-wa-key',
  SUPABASE_URL: 'https://example.supabase.co', SUPABASE_KEY: 'test-existing-anon-key'
};
function body(overrides = {}) {
  return {
    submissionId: randomUUID(), name: 'اختبار آلي', phone: '+966500000001',
    answers: Object.fromEntries(quiz.content.questions.map(question => [question.id, question.options[0].id])),
    src: 'tiktok', consent: true, website: '', elapsedMs: 30000, ...overrides
  };
}
const accepted = () => ({ state: 'accepted', providerId: 'mock-provider-id' });
function mocks() { return { save: async () => accepted(), telegram: async () => accepted(), whatsapp: async () => accepted() }; }
async function listen(t, options = {}) {
  const service = createService({ env, dbPath: ':memory:', providers: mocks(), ...options });
  const server = await new Promise(resolve => { const server = service.app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await service.close(); });
  const url = 'http://127.0.0.1:' + server.address().port + '/api/quiz-submit';
  async function post(value, headers = {}) {
    return fetch(url, { method: 'POST', headers: { Origin: ORIGINAL_ORIGIN, 'Content-Type': 'application/json', ...headers }, body: typeof value === 'string' ? value : JSON.stringify(value) });
  }
  return { ...service, url, post };
}

test('HTTP acceptance commits all jobs; exact retries create no new jobs; changed payload conflicts', async t => {
  const api = await listen(t); const input = body();
  const first = await api.post(input);
  assert.equal(first.status, 202); assert.deepEqual(await first.json(), { ok: true, accepted: true, submissionId: input.submissionId, state: 'queued' });
  assert.equal(api.store.jobs(input.submissionId).length, 3);
  assert.equal((await api.post(input)).status, 202);
  assert.equal(api.store.jobs(input.submissionId).length, 3);
  assert.equal((await api.post({ ...input, phone: '+966500000002' })).status, 409);
  const cooldown = await api.post(body()); assert.equal(cooldown.status, 429); assert.equal((await cooldown.json()).error, 'phone_cooldown');
  await api.worker.tick();
  assert.ok(api.store.jobs(input.submissionId).every(job => job.state === 'accepted'));
});

test('v2 scoring, result labels, canonical context book and exact legacy lead fields are server-derived', () => {
  for (const key of ['A', 'B', 'C', 'D']) {
    for (const context of ['waiting', 'ended', 'repeated', 'curious']) {
      const answers = Object.fromEntries(quiz.content.questions.map(question => [question.id, question.kind === 'context' ? question.options.find(option => option.context === context).id : question.options.find(option => option.scores[key] === 3).id]));
      const submission = validateSubmission(body({ answers }), quiz);
      assert.equal(submission.result.winner, key);
      assert.equal(submission.result.patternName, quiz.content.patterns[key].name);
      assert.equal(submission.result.context, context);
      assert.equal(submission.bookUrl, quiz.content.products[submission.result.productKey].url);
      assert.deepEqual(Object.keys(submission.lead).sort(), ['name', 'whatsapp', 'pattern', 'pattern_key', 'book', 'book_link', 'scores', 'source'].sort());
      assert.equal(submission.lead.scores[key], 21);
      assert.ok(submission.lead.book_link.includes('utm_campaign=heart_compass_v2'));
    }
  }
});

test('strict validation rejects legacy answers, injected providers/destinations, missing consent and invalid inputs', async t => {
  const api = await listen(t);
  const invalid = [
    body({ answers: [1, 2, 3, 4, 1] }), body({ answers: {} }), body({ pattern: 'A' }),
    body({ text: 'attacker message' }), body({ chat_id: 'attacker' }), body({ consent: false }),
    body({ website: 'spam' }), body({ elapsedMs: 1 }), body({ elapsedMs: '30000' }), body({ phone: 'https://attacker.test' }),
    body({ name: '<script>' }), body({ name: 'a' }), body({ src: 'javascript:alert(1)' }), body({ submissionId: 'not-uuid' })
  ];
  for (const value of invalid) assert.equal((await api.post(value)).status, 400);
  assert.equal(api.store.db.prepare('SELECT count(*) AS n FROM quiz_submissions_v2').get().n, 0);
});

test('CORS permits only original browser POST/JSON preflight; malformed, large, non-JSON fail', async t => {
  const api = await listen(t);
  const options = await fetch(api.url, { method: 'OPTIONS', headers: { Origin: ORIGINAL_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  assert.equal(options.status, 204); assert.equal(options.headers.get('access-control-allow-origin'), ORIGINAL_ORIGIN);
  assert.equal((await fetch(api.url, { method: 'OPTIONS', headers: { Origin: ORIGINAL_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' } })).status, 403);
  assert.equal((await api.post(body(), { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await api.post(body(), { Origin: '' })).status, 403);
  assert.equal((await api.post('{}', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await api.post('{broken')).status, 400);
  assert.equal((await api.post(JSON.stringify(body({ name: 'x'.repeat(5000) })))).status, 413);
});

test('durable jobs survive restart; interrupted provider jobs become unknown, never retried', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aden-outbox-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'quiz.db');
  let store = new Store(filename); const submission = validateSubmission(body(), quiz);
  assert.equal(store.accept(submission, '127.0.0.1').accepted, true);
  store.claim('whatsapp'); store.close();
  store = new Store(filename); t.after(() => store.close());
  assert.equal(store.jobs(submission.payload.submissionId).find(job => job.kind === 'whatsapp').state, 'unknown');
  let sends = 0;
  const worker = makeWorker(store, { ...mocks(), whatsapp: async () => { sends++; return accepted(); } });
  await worker.tick(); await worker.tick();
  assert.equal(sends, 0);
  assert.equal(store.jobs(submission.payload.submissionId).filter(job => job.state === 'accepted').length, 2);
  assert.equal(store.accept(submission, '127.0.0.1').replay, true);
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
});

test('partial provider failures are independent; unknown outcomes never duplicate successful save/Telegram', async () => {
  const store = new Store(':memory:'); const submission = validateSubmission(body(), quiz); store.accept(submission, 'test-ip');
  const calls = { save: 0, telegram: 0, whatsapp: 0 };
  const worker = makeWorker(store, {
    save: async () => { calls.save++; return accepted(); },
    telegram: async () => { calls.telegram++; return accepted(); },
    whatsapp: async () => { calls.whatsapp++; throw new ProviderError('network_outcome_unknown'); }
  });
  await worker.tick(); await worker.tick();
  assert.deepEqual(calls, { save: 1, telegram: 1, whatsapp: 1 });
  assert.equal(store.jobs(submission.payload.submissionId).find(job => job.kind === 'whatsapp').state, 'unknown');
  store.close();
});

test('safe explicit 429 retries are durable, bounded and independent', async () => {
  let timestamp = 1000000000; const now = () => timestamp;
  const store = new Store(':memory:', { now }); const submission = validateSubmission(body(), quiz); store.accept(submission, 'test-ip');
  let sends = 0;
  const worker = makeWorker(store, { ...mocks(), whatsapp: async () => { sends++; throw new ProviderError('provider_rate_limited', 'queued', 60000); } });
  for (let i = 0; i < 5; i++) { await worker.tick(); timestamp += 60000; }
  assert.equal(sends, 4);
  const job = store.jobs(submission.payload.submissionId).find(item => item.kind === 'whatsapp');
  assert.equal(job.state, 'failed'); assert.equal(job.error_code, 'rate_retry_exhausted');
  store.close();
});

test('global, IP and phone rates persist and cannot be bypassed by fresh UUIDs', () => {
  let timestamp = 1000000000; const now = () => timestamp;
  const store = new Store(':memory:', { now, limits: { ipHour: 2, globalHour: 3, globalDay: 4 } });
  const submit = (number, ip) => store.accept(validateSubmission(body({ phone: '+96650000000' + number }), quiz), ip);
  assert.equal(submit(1, 'one').accepted, true); assert.equal(submit(2, 'one').accepted, true);
  assert.equal(submit(3, 'one').error, 'rate_limited'); assert.equal(submit(3, 'two').accepted, true);
  assert.equal(submit(4, 'three').error, 'rate_limited');
  timestamp += 3600001;
  assert.equal(submit(4, 'three').accepted, true); assert.equal(submit(5, 'four').error, 'rate_limited');
  assert.equal(submit(1, 'new-ip').error, 'phone_cooldown'); store.close();
});

test('real provider adapters use fixed destinations/templates, existing lead fields and accepted message IDs', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    if (url.includes('supabase.co')) return new Response(null, { status: 201 });
    if (url.includes('telegram.org')) return Response.json({ ok: true, result: { message_id: 123 } });
    return Response.json({ success: true, data: { msgId: 456, status: 'in_progress' } });
  };
  const { providers } = makeProviders(env, fetchImpl); const submission = validateSubmission(body(), quiz);
  assert.deepEqual(await providers.save(submission), { state: 'accepted' });
  assert.deepEqual(await providers.telegram(submission), { state: 'accepted', providerId: '123' });
  assert.deepEqual(await providers.whatsapp(submission), { state: 'accepted', providerId: '456' });
  assert.deepEqual(requests[0].body, JSON.parse(JSON.stringify(submission.lead)));
  assert.equal(requests[1].body.chat_id, 'fixed-admin-chat'); assert.ok(!Object.hasOwn(requests[1].body, 'parse_mode'));
  assert.equal(requests[2].body.to, submission.payload.phone);
  assert.ok(requests[2].body.text.includes(submission.guideUrl)); assert.ok(requests[2].body.text.includes(submission.bookUrl));
  assert.ok(!requests[2].body.text.includes('خلال الساعات القادمة'));
  assert.equal(requests[2].options.redirect, 'error'); assert.ok(requests[2].options.signal);
});

test('provider errors do not leak response bodies or secrets and ambiguous success is unknown', async () => {
  const submission = validateSubmission(body(), quiz);
  const cases = [
    [async () => { throw new Error('secret-token-and-user-phone'); }, 'network_outcome_unknown', 'unknown'],
    [async () => new Response('private provider error', { status: 500 }), 'provider_outcome_unknown_500', 'unknown'],
    [async () => new Response('private provider error', { status: 401 }), 'provider_rejected_401', 'failed'],
    [async () => new Response('not json'), 'invalid_provider_response', 'unknown'],
    [async () => Response.json({ success: true }), 'invalid_provider_response', 'unknown'],
    [async () => new Response('rate limited', { status: 429, headers: { 'Retry-After': '2' } }), 'provider_rate_limited', 'queued']
  ];
  for (const [fetchImpl, code, state] of cases) {
    await assert.rejects(makeProviders(env, fetchImpl).providers.whatsapp(submission), error => error.message === code && error.state === state);
  }
});

test('unconfigured service returns genuine 503 without accepting a submission', async t => {
  const api = await listen(t, { env: { QUIZ_SOURCE_DIR: env.QUIZ_SOURCE_DIR }, providers: undefined });
  assert.equal((await api.post(body())).status, 503);
  assert.equal(api.store.db.prepare('SELECT count(*) AS n FROM quiz_submissions_v2').get().n, 0);
});

test('only known pre-connection DNS failures retry Supabase; messaging DNS and ambiguous timeouts remain unknown', async () => {
  const submission = validateSubmission(body(), quiz);
  for (const code of ['ENOTFOUND', 'EAI_AGAIN']) {
    const fetchImpl = async () => { throw new TypeError('fetch failed', { cause: { code } }); };
    const { providers } = makeProviders(env, fetchImpl);
    await assert.rejects(providers.save(submission), error => error.code === 'dns_unavailable' && error.state === 'queued' && error.retryMs === 300000);
    for (const kind of ['telegram', 'whatsapp']) {
      await assert.rejects(providers[kind](submission), error => error.code === 'network_outcome_unknown' && error.state === 'unknown');
    }
  }
  for (const code of ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET']) {
    const fetchImpl = async () => { throw new TypeError('fetch failed', { cause: { code } }); };
    await assert.rejects(makeProviders(env, fetchImpl).providers.save(submission), error => error.code === 'network_outcome_unknown' && error.state === 'unknown');
  }
  await assert.rejects(makeProviders(env, async () => { throw Object.assign(new Error('unknown origin'), { code: 'ENOTFOUND' }); }).providers.save(submission), error => error.state === 'unknown');
});

test('Supabase DNS retries stop after 24 attempts and never repeat accepted messages', async () => {
  let timestamp = 1000000000;
  const store = new Store(':memory:', { now: () => timestamp });
  const submission = validateSubmission(body(), quiz); store.accept(submission, 'test-ip');
  const calls = { save: 0, telegram: 0, whatsapp: 0 };
  const worker = makeWorker(store, {
    save: async () => { calls.save++; throw new ProviderError('dns_unavailable', 'queued', 300000); },
    telegram: async () => { calls.telegram++; return accepted(); },
    whatsapp: async () => { calls.whatsapp++; return accepted(); }
  });
  await worker.tick(); await worker.tick();
  assert.equal(calls.save, 1);
  for (let i = 0; i < 24; i++) { timestamp += 300000; await worker.tick(); }
  assert.deepEqual(calls, { save: 24, telegram: 1, whatsapp: 1 });
  const jobs = store.jobs(submission.payload.submissionId);
  assert.equal(jobs.find(job => job.kind === 'save').state, 'failed');
  assert.equal(jobs.find(job => job.kind === 'save').error_code, 'dns_retry_exhausted');
  assert.ok(jobs.filter(job => job.kind !== 'save').every(job => job.state === 'accepted'));
  store.close();
});
