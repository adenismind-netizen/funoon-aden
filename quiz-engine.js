(function (root, factory) {
  'use strict';
  const engine = factory();
  if (typeof module === 'object' && module.exports) module.exports = engine;
  else root.AdenQuizEngine = engine;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const KEYS = ['A', 'B', 'C', 'D'];

  function resolveAnswers(content, answers) {
    return content.questions.map(question => ({
      question,
      option: question.options.find(option => option.id === answers[question.id])
    }));
  }

  function calculateResult(content, answers) {
    const resolved = resolveAnswers(content, answers);
    if (resolved.some(item => !item.option)) throw new Error('Complete every question first.');
    const scores = { A: 0, B: 0, C: 0, D: 0 };
    const patternAnswers = resolved.filter(item => item.question.kind === 'pattern');
    patternAnswers.forEach(({ option }) => KEYS.forEach(key => {
      scores[key] += option.scores[key] || 0;
    }));
    const total = KEYS.reduce((sum, key) => sum + scores[key], 0);
    if (!total) throw new Error('No scored answers.');
    const highest = Math.max(...Object.values(scores));
    const leaders = KEYS.filter(key => scores[key] === highest);
    let candidates = [...leaders];
    // On a tie, use the most recent discriminating answer, never a fixed A-first order.
    for (const { option } of [...patternAnswers].reverse()) {
      if (candidates.length === 1) break;
      const strongest = Math.max(...candidates.map(key => option.scores[key] || 0));
      candidates = candidates.filter(key => (option.scores[key] || 0) === strongest);
    }
    const winner = candidates[0];
    const ranked = [...KEYS].sort((a, b) => scores[b] - scores[a]);
    const secondary = ranked.find(key => key !== winner);
    const shares = Object.fromEntries(KEYS.map(key => [key, Math.floor(scores[key] / total * 100)]));
    const fractional = [...KEYS].sort((a, b) =>
      (scores[b] / total * 100 % 1) - (scores[a] / total * 100 % 1));
    const remainder = 100 - Object.values(shares).reduce((a, b) => a + b, 0);
    fractional.slice(0, remainder).forEach(key => shares[key]++);
    const context = resolved.find(item => item.question.kind === 'context').option.context;
    const recommendation = content.recommendations[context];
    const productKey = typeof recommendation === 'string' ? recommendation : recommendation[winner];
    return {
      winner, secondary, scores, shares, total, context, productKey,
      tied: leaders.length > 1,
      mixed: highest - scores[secondary] <= 3
    };
  }

  function normalizePhone(value) {
    let phone = String(value || '').trim()
      .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
      .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
      .replace(/[\s().-]/g, '');
    if (!/^\+?\d+$/.test(phone)) return null;
    if (phone.startsWith('00')) phone = phone.slice(2);
    if (phone.startsWith('+')) phone = phone.slice(1);
    if (/^05\d{8}$/.test(phone)) phone = '966' + phone.slice(1);
    else if (/^5\d{8}$/.test(phone)) phone = '966' + phone;
    if (!/^[1-9]\d{8,14}$/.test(phone)) return null;
    if (phone.startsWith('966') && !/^9665\d{8}$/.test(phone)) return null;
    return '+' + phone;
  }

  function sanitizeSource(value) {
    return String(value || 'other').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'other';
  }

  function productUrl(product, result, source) {
    const url = new URL(product.url);
    url.searchParams.set('utm_source', sanitizeSource(source));
    url.searchParams.set('utm_medium', 'interactive_quiz');
    url.searchParams.set('utm_campaign', 'heart_compass_v2');
    url.searchParams.set('utm_content', result.context + '_' + result.winner);
    return url.href;
  }

  return { KEYS, resolveAnswers, calculateResult, normalizePhone, sanitizeSource, productUrl };
});
