const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const engine = require('../quiz-engine.js');
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../quiz-content.js'), 'utf8'), sandbox);
const content = sandbox.window.ADEN_QUIZ_CONTENT;
const patternQuestions = content.questions.filter(q => q.kind === 'pattern');

function answersFor(pattern, context = 'curious') {
  return Object.fromEntries(content.questions.map(q => [q.id, q.kind === 'context'
    ? q.options.find(o => o.context === context).id
    : q.options.find(o => o.scores[pattern] === 3).id]));
}

test('every pattern is reachable and its book follows the relationship context', () => {
  for (const pattern of engine.KEYS) {
    for (const context of ['waiting', 'ended', 'repeated', 'curious']) {
      const result = engine.calculateResult(content, answersFor(pattern, context));
      assert.equal(result.winner, pattern);
      assert.equal(result.total, 21);
      assert.equal(result.shares[pattern], 100);
      assert.equal(result.productKey, context === 'waiting' ? 'distance' : context === 'ended'
        ? 'attachment' : { A: 'attachment', B: 'reflection', C: 'shadow', D: 'self' }[pattern]);
      assert.equal(result.mixed, false);
    }
  }
});

test('all 16,384 answer combinations yield a valid, deterministic result and honest totals', () => {
  const tiedWinners = new Set();
  for (let mask = 0; mask < 4 ** patternQuestions.length; mask++) {
    const answers = answersFor('A');
    patternQuestions.forEach((q, index) => { answers[q.id] = q.options[Math.floor(mask / 4 ** index) % 4].id; });
    const result = engine.calculateResult(content, answers);
    assert.equal(result.total, 21);
    assert.equal(Object.values(result.shares).reduce((a, b) => a + b, 0), 100);
    assert.equal(result.scores[result.winner], Math.max(...Object.values(result.scores)));
    assert.ok(content.products[result.productKey]);
    assert.deepEqual(result, engine.calculateResult(content, answers));
    if (result.tied) tiedWinners.add(result.winner);
  }
  assert.deepEqual([...tiedWinners].sort(), engine.KEYS);
});

test('missing or invalid answers never produce a result or silently add scores', () => {
  const answers = answersFor('B');
  delete answers[patternQuestions[2].id];
  assert.throws(() => engine.calculateResult(content, answers), /Complete/);
  answers[patternQuestions[2].id] = 'unknown-answer';
  assert.throws(() => engine.calculateResult(content, answers), /Complete/);
});

test('Arabic, Saudi and international phone formats normalize without accepting invalid input', () => {
  for (const value of ['0551234567', '٥٥١٢٣٤٥٦٧', '+966 55 123 4567', '00966551234567']) {
    assert.equal(engine.normalizePhone(value), '+966551234567');
  }
  assert.equal(engine.normalizePhone('+971 50 123 4567'), '+971501234567');
  assert.equal(engine.normalizePhone('+962791234567'), '+962791234567');
  for (const value of ['', '05', '055letters1234567', '+966123456789', '0000000000', '++966551234567', '1234567890123456']) {
    assert.equal(engine.normalizePhone(value), null);
  }
});

test('product links preserve attribution and never include contact information or individual answers', () => {
  const result = engine.calculateResult(content, answersFor('C', 'waiting'));
  const url = new URL(engine.productUrl(content.products.distance, result, 'TikTok<script>'));
  assert.equal(url.hostname, 'aden-art.com');
  assert.equal(url.searchParams.get('utm_source'), 'tiktokscript');
  assert.equal(url.searchParams.get('utm_campaign'), 'heart_compass_v2');
  assert.equal(url.searchParams.get('utm_content'), 'waiting_C');
  assert.equal(url.searchParams.size, 4);
});

test('all recommendations have real local covers and all result guides exist', () => {
  for (const productKey of Object.keys(content.products)) {
    const cover = path.join(__dirname, '../assets/quiz', productKey + (productKey === 'distance' ? '.webp' : '.jpg'));
    assert.ok(fs.statSync(cover).size > 1000, productKey);
  }
  for (const name of ['qalaq.pdf', 'tafadi.pdf', 'fawdi.pdf', 'amen.pdf']) {
    const guide = fs.readFileSync(path.join(__dirname, '..', name));
    assert.equal(guide.subarray(0, 4).toString(), '%PDF');
  }
});
