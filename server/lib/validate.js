'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

function loadQuiz(sourceDir = process.env.QUIZ_SOURCE_DIR || path.resolve(__dirname, '../..')) {
  // Only trusted release files execute; no request-provided code or path.
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(sourceDir, 'quiz-content.js'), 'utf8'), context, { timeout: 1000 });
  const content = context.window.ADEN_QUIZ_CONTENT;
  const engine = require(path.join(sourceDir, 'quiz-engine.js'));
  if (content.version !== '2.0' || content.questions.length !== 8) throw new Error('unsupported_quiz_version');
  return { content, engine };
}

const LEGACY_NAMES = { A: 'النمط القلق', B: 'النمط التفادي', C: 'النمط الفوضوي', D: 'النمط الآمن' };
const GUIDES = { A: 'qalaq.pdf', B: 'tafadi.pdf', C: 'fawdi.pdf', D: 'amen.pdf' };
const QUIZ_BASE = 'https://adenismind-netizen.github.io/funoon-aden/';
const FIELDS = ['submissionId', 'name', 'phone', 'answers', 'src', 'consent', 'website', 'elapsedMs'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function validateSubmission(body, quiz) {
  if (!isObject(body) || Object.keys(body).some(key => !FIELDS.includes(key))) return { error: 'bad_body' };
  if (typeof body.submissionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.submissionId)) return { error: 'bad_submission_id' };
  if (body.consent !== true) return { error: 'consent_required' };
  if (body.website !== '') return { error: 'bad_submission' };
  if (!Number.isSafeInteger(body.elapsedMs) || body.elapsedMs < 8000 || body.elapsedMs > 604800000) return { error: 'bad_elapsed' };
  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/gu, ' ') : '';
  if (name.length < 2 || name.length > 60 || /[\x00-\x1f\x7f<>\u202a-\u202e\u2066-\u2069]/u.test(body.name)) return { error: 'bad_name' };
  if (typeof body.phone !== 'string' || body.phone.length > 32) return { error: 'invalid_phone' };
  const phone = quiz.engine.normalizePhone(body.phone);
  if (!phone) return { error: 'invalid_phone' };
  if (typeof body.src !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(body.src)) return { error: 'bad_source' };
  if (!isObject(body.answers) || Object.keys(body.answers).length !== quiz.content.questions.length) return { error: 'bad_answers' };
  const answers = {};
  for (const question of quiz.content.questions) {
    if (!Object.hasOwn(body.answers, question.id) || !question.options.some(option => option.id === body.answers[question.id])) return { error: 'bad_answers' };
    answers[question.id] = body.answers[question.id];
  }
  const result = quiz.engine.calculateResult(quiz.content, answers);
  const product = quiz.content.products[result.productKey];
  const payload = {
    submissionId: body.submissionId.toLowerCase(), name, phone, answers, src: body.src,
    consent: true, website: '', elapsedMs: body.elapsedMs, version: quiz.content.version
  };
  const lead = {
    name, whatsapp: phone, pattern: LEGACY_NAMES[result.winner], pattern_key: result.winner,
    book: product.title, book_link: quiz.engine.productUrl(product, result, body.src),
    scores: result.scores, source: body.src
  };
  return {
    payload, payloadHash: digest(JSON.stringify(payload)), lead,
    result: { ...result, patternName: quiz.content.patterns[result.winner].name },
    guideUrl: QUIZ_BASE + GUIDES[result.winner], bookUrl: product.url
  };
}

module.exports = { loadQuiz, validateSubmission, LEGACY_NAMES, GUIDES, digest };
