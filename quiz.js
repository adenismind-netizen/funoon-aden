(function () {
  'use strict';
  const content = window.ADEN_QUIZ_CONTENT;
  const engine = window.AdenQuizEngine;
  const $ = id => document.getElementById(id);
  if (!content || !engine) {
    $('start-button').disabled = true;
    $('start-button').textContent = 'تعذّر تحميل التجربة. حدّثي الصفحة وحاولي مجددًا.';
    return;
  }

  const STORAGE_KEY = 'aden-heart-compass-v2';
  const SOURCE = engine.sanitizeSource(new URLSearchParams(location.search).get('src'));
  const WA_NUMBER = '966558139919';
  const GUIDES = { A: 'qalaq.pdf', B: 'tafadi.pdf', C: 'fawdi.pdf', D: 'amen.pdf' };
  const LABELS = { A: 'طلب الطمأنينة', B: 'حماية المسافة', C: 'القرب والحذر', D: 'خطوة متوازنة' };
  const number = value => new Intl.NumberFormat('ar-SA').format(value);
  let state = { version: content.version, answers: {}, current: 0, screen: 'intro', leadSaved: false };
  let result = null;
  let transitioning = false;
  let submitting = false;
  let toastTimer;
  const openedAt = Date.now();
  let pendingSubmission = null;

  // The API validates results, stores the lead and queues both messages on the server.
  // Provider credentials and database credentials never reach the browser.
  const LEADS_URL = 'https://adenartapp.com/api/quiz-submit';

  function track(name, detail = {}) {
    // No network request, contact data, or individual answers. A consent-aware host may subscribe.
    const event = { name, version: content.version, source: SOURCE, ...detail };
    window.dispatchEvent(new CustomEvent('aden:quiz-event', { detail: event }));
    if (Array.isArray(window.dataLayer)) window.dataLayer.push({ event: 'aden_' + name, ...event });
  }

  function persist() {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) { /* Private browsing. */ }
  }

  function restore() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY));
      if (!saved || saved.version !== content.version || typeof saved.answers !== 'object' || !saved.answers) return;
      const valid = {};
      content.questions.forEach(question => {
        if (question.options.some(option => option.id === saved.answers[question.id])) valid[question.id] = saved.answers[question.id];
      });
      const firstMissing = content.questions.findIndex(question => !valid[question.id]);
      state.answers = valid;
      state.current = firstMissing === -1 ? content.questions.length - 1 : firstMissing;
      if (Number.isInteger(saved.current)) state.current = Math.max(0, Math.min(saved.current, state.current));
      state.leadSaved = saved.leadSaved === true;
      state.screen = saved.screen === 'result' && firstMissing === -1 ? 'result' : 'intro';
    } catch (_) { /* A corrupt or inaccessible session must not block the quiz. */ }
  }

  function screen(name, focusId) {
    ['intro', 'quiz', 'result'].forEach(key => { $(key + '-screen').hidden = key !== name; });
    state.screen = name;
    persist();
    window.scrollTo({ top: 0, behavior: 'instant' });
    if (focusId) requestAnimationFrame(() => $(focusId).focus({ preventScroll: true }));
  }

  function announce(message) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
  }

  function syncIntro() {
    const hasProgress = Object.keys(state.answers).length > 0;
    $('resume-panel').hidden = !hasProgress;
    $('start-button').innerHTML = hasProgress
      ? 'ابدئي قراءة جديدة <span aria-hidden="true">↺</span>'
      : 'اكتشفي بوصلة قلبك <span aria-hidden="true">←</span>';
    $('resume-button').textContent = Object.keys(state.answers).length === content.questions.length
      ? 'عودي إلى نتيجتكِ ←' : 'أكملي من حيث توقفتِ ←';
  }

  function resetLead() {
    pendingSubmission = null;
    $('lead-form').reset();
    $('lead-form').hidden = false;
    $('lead-success').hidden = true;
    $('form-message').textContent = '';
    $('lead-submit').disabled = false;
    state.leadSaved = false;
  }

  function start() {
    state = { version: content.version, answers: {}, current: 0, screen: 'quiz', leadSaved: false };
    result = null;
    resetLead();
    track('start');
    renderQuestion();
    screen('quiz', 'question-title');
  }

  function renderQuestion() {
    transitioning = false;
    const question = content.questions[state.current];
    $('question-counter').textContent = 'الموقف ' + number(state.current + 1) + ' من ' + number(content.questions.length);
    $('question-eyebrow').textContent = question.eyebrow;
    $('question-title').textContent = question.prompt;
    $('question-hint').textContent = question.hint;
    $('quiz-progress').setAttribute('aria-valuenow', state.current);
    $('progress-fill').style.width = state.current / content.questions.length * 100 + '%';
    $('back-button').disabled = state.current === 0;
    $('next-button').disabled = !state.answers[question.id];
    $('next-button').textContent = state.current === content.questions.length - 1 ? 'اكشفي بوصلة قلبك ←' : 'التالي ←';
    const options = $('options');
    options.replaceChildren();
    const selectedIndex = question.options.findIndex(option => option.id === state.answers[question.id]);
    question.options.forEach((option, index) => {
      const selected = index === selectedIndex;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'option-card' + (selected ? ' selected' : '');
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(selected));
      button.tabIndex = (selectedIndex === -1 ? index === 0 : selected) ? 0 : -1;
      const marker = document.createElement('span');
      marker.className = 'option-marker';
      marker.setAttribute('aria-hidden', 'true');
      marker.textContent = ['أ', 'ب', 'ج', 'د'][index];
      const copy = document.createElement('span');
      copy.className = 'option-copy';
      const title = document.createElement('strong');
      title.textContent = option.text;
      copy.append(title);
      if (option.detail) {
        const detail = document.createElement('span');
        detail.textContent = option.detail;
        copy.append(detail);
      }
      const tick = document.createElement('span');
      tick.className = 'option-tick';
      tick.textContent = '✓';
      tick.setAttribute('aria-hidden', 'true');
      button.append(marker, copy, tick);
      button.addEventListener('click', () => selectOption(option.id, index));
      button.addEventListener('keydown', event => {
        if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        let next = index;
        if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = question.options.length - 1;
        else next = (index + (['ArrowDown', 'ArrowLeft'].includes(event.key) ? 1 : -1) + question.options.length) % question.options.length;
        selectOption(question.options[next].id, next);
        options.children[next].focus();
      });
      options.append(button);
    });
    persist();
    track('question_view', { step: state.current + 1 });
  }

  function selectOption(id, index) {
    if (transitioning) return;
    const question = content.questions[state.current];
    if (!question.options.some(option => option.id === id)) return;
    if (state.answers[question.id] && state.answers[question.id] !== id) resetLead();
    state.answers[question.id] = id;
    [...$('options').children].forEach((button, i) => {
      button.classList.toggle('selected', i === index);
      button.setAttribute('aria-checked', String(i === index));
      button.tabIndex = i === index ? 0 : -1;
    });
    $('next-button').disabled = false;
    persist();
  }

  function next() {
    if (transitioning || !state.answers[content.questions[state.current].id]) return;
    transitioning = true;
    $('next-button').disabled = true;
    track('question_complete', { step: state.current + 1 });
    // A short lock prevents an accidental double-tap from advancing through a saved answer.
    setTimeout(() => {
      if (state.current < content.questions.length - 1) {
        state.current++;
        renderQuestion();
        window.scrollTo({ top: 0, behavior: 'instant' });
        $('question-title').focus({ preventScroll: true });
      } else {
        renderResult();
        screen('result', 'result-name');
        transitioning = false;
        track('complete', { pattern: result.winner, context: result.context, product: result.productKey });
      }
    }, 160);
  }

  function fillList(id, entries) {
    $(id).replaceChildren(...entries.map(text => {
      const item = document.createElement('li');
      item.textContent = text;
      return item;
    }));
  }

  function renderResult() {
    result = engine.calculateResult(content, state.answers);
    const pattern = content.patterns[result.winner];
    const product = content.products[result.productKey];
    $('result-name').textContent = pattern.name;
    $('result-kicker').textContent = pattern.kicker;
    $('result-description').textContent = pattern.description;
    $('result-strength').textContent = pattern.strength;
    $('result-need').textContent = pattern.need;
    $('result-mixed').hidden = !result.mixed;
    $('result-mixed').textContent = 'قراءتكِ تجمع بين اتجاهين متقاربين: «' + pattern.name + '» و«' + content.patterns[result.secondary].name + '». نبدأ بالأول، دون اختصار تجربتكِ في اسم واحد.';
    fillList('result-traits', pattern.traits);
    $('tendencies').replaceChildren(...engine.KEYS.map(key => {
      const row = document.createElement('div');
      row.className = 'tendency-row';
      const head = document.createElement('div');
      head.className = 'tendency-head';
      const label = document.createElement('span'); label.textContent = LABELS[key];
      const value = document.createElement('span'); value.textContent = number(result.shares[key]) + '٪ من النقاط';
      head.append(label, value);
      const track = document.createElement('div'); track.className = 'tendency-track'; track.setAttribute('aria-hidden', 'true');
      const fill = document.createElement('i'); fill.style.width = result.shares[key] + '%';
      track.append(fill); row.append(head, track); return row;
    }));
    $('exercise-title').textContent = pattern.exercise.title;
    $('exercise-steps').replaceChildren(...pattern.exercise.steps.map((text, i) => {
      const item = document.createElement('li'); item.className = 'step-item';
      const count = document.createElement('span'); count.textContent = number(i + 1);
      const body = document.createElement('div'); body.textContent = text;
      item.append(count, body); return item;
    }));
    $('recommendation-reason').textContent = 'اخترنا هذه القراءة بناءً على مرحلتكِ وإجاباتكِ: ' + product.fit;
    $('book-title').textContent = product.title;
    $('book-description').textContent = product.description;
    fillList('book-bullets', product.bullets);
    $('book-price').textContent = number(product.price) + ' ر.س';
    $('book-format').textContent = product.pages ? 'PDF · ' + number(product.pages) + ' صفحة' : 'كتاب إلكتروني · PDF';
    $('book-image').src = 'assets/quiz/' + result.productKey + (result.productKey === 'distance' ? '.webp' : '.jpg');
    $('book-image').alt = 'غلاف ' + product.title;
    $('book-link').href = engine.productUrl(product, result, SOURCE);
    $('dock-title').textContent = product.title;
    $('dock-link').href = $('book-link').href;
    $('guide-link').href = GUIDES[result.winner];
    $('share-description').textContent = pattern.share;
    $('lead-form').hidden = state.leadSaved;
    $('lead-success').hidden = !state.leadSaved;
    $('whatsapp-link').href = whatsappUrl();
    $('secondary-offer').hidden = !['attachment', 'reflection', 'self'].includes(result.productKey);
    $('secondary-offer').replaceChildren();
    if (!$('secondary-offer').hidden) {
      $('secondary-offer').append('تفضّلين رحلة أوسع؟ ');
      const bundle = document.createElement('a');
      bundle.href = engine.productUrl({ url: 'https://aden-art.com/باقة-ثلاثي-عدن-أقوى-3-كتب/p341970990' }, result, SOURCE);
      bundle.textContent = 'باقة ثلاثي عدن تجمع ٣ كتب بسعر ١١٩ ر.س ↗';
      bundle.addEventListener('click', () => track('bundle_click', { pattern: result.winner }));
      $('secondary-offer').append(bundle);
    }
  }

  function whatsappUrl() {
    if (!result) return '#';
    const pattern = content.patterns[result.winner];
    const message = 'أهلًا فنون عدن، أكملت بوصلة قلبي وكانت قراءتي: ' + pattern.name + '. أرغب في دليلي المجاني ومعرفة القراءة المناسبة لي.';
    return 'https://wa.me/' + WA_NUMBER + '?text=' + encodeURIComponent(message);
  }

  async function submitLead(event) {
    event.preventDefault();
    if (submitting || state.leadSaved || !result) return;
    const name = $('lead-name').value.trim();
    const phone = engine.normalizePhone($('lead-phone').value);
    $('lead-name').removeAttribute('aria-invalid');
    $('lead-phone').removeAttribute('aria-invalid');
    if (name.length < 2) {
      $('form-message').textContent = 'اكتبي اسمكِ الأول بحرفين على الأقل.';
      $('lead-name').setAttribute('aria-invalid', 'true'); $('lead-name').focus(); return;
    }
    if (!phone) {
      $('form-message').textContent = 'راجعي رقم واتساب. للأرقام خارج السعودية أضيفي مفتاح الدولة مثل +971.';
      $('lead-phone').setAttribute('aria-invalid', 'true'); $('lead-phone').focus(); return;
    }
    if (!$('lead-consent').checked) {
      $('form-message').textContent = 'الموافقة مطلوبة لحفظ طلب التواصل. يمكنكِ تحميل الدليل دون تسجيل.';
      $('lead-consent').focus(); return;
    }
    const controller = new AbortController();
    const submittedAnswers = JSON.stringify(state.answers);
    const timeout = setTimeout(() => controller.abort(), 15000);
    submitting = true;
    $('lead-submit').disabled = true;
    $('form-message').textContent = 'جارٍ إرسال طلب المتابعة…';
    try {
      const identity = JSON.stringify({ name, phone, answers: state.answers });
      if (!pendingSubmission || pendingSubmission.identity !== identity) {
        pendingSubmission = {
          identity,
          body: { submissionId: crypto.randomUUID(), name, phone, answers: { ...state.answers }, src: SOURCE, consent: true, website: $('lead-website').value, elapsedMs: Date.now() - openedAt }
        };
      }
      const response = await fetch(LEADS_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pendingSubmission.body)
      });
      const receipt = await response.json();
      if (!response.ok || receipt.ok !== true || receipt.accepted !== true || receipt.submissionId !== pendingSubmission.body.submissionId) {
        const error = new Error('Lead submission unavailable.');
        error.cooldown = receipt.error === 'phone_cooldown';
        error.rateLimited = response.status === 429;
        throw error;
      }
      if (JSON.stringify(state.answers) !== submittedAnswers || state.screen !== 'result') return;
      state.leadSaved = true;
      persist();
      $('lead-form').hidden = true;
      $('lead-success').hidden = false;
      $('whatsapp-link').href = whatsappUrl();
      $('lead-phone').value = '';
      $('lead-name').value = '';
      $('form-message').textContent = '';
      track('lead_saved', { pattern: result.winner });
    } catch (error) {
      if (JSON.stringify(state.answers) !== submittedAnswers || state.screen !== 'result') return;
      const message = error.cooldown
        ? 'سبق استلام طلب لهذا الرقم مؤخرًا. إذا لم تصلكِ الرسالة، '
        : error.rateLimited ? 'وصلنا عدد كبير من الطلبات الآن. حاولي لاحقًا، أو '
          : 'تعذّر تأكيد استلام الطلب الآن. يمكنكِ المحاولة مجددًا، أو ';
      $('form-message').replaceChildren(document.createTextNode(message));
      const link = document.createElement('a'); link.href = whatsappUrl(); link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'اطلبيه مباشرة على واتساب ↗';
      $('form-message').append(link);
    } finally {
      clearTimeout(timeout);
      submitting = false;
      $('lead-submit').disabled = false;
    }
  }

  async function share() {
    const url = new URL(location.href);
    url.search = '?src=friend';
    url.hash = '';
    const data = { title: 'بوصلة قلبك — فنون عدن', text: 'ما الذي يحتاجه قلبكِ الآن؟ جربي هذه المواقف الثمانية وخذي تمرينًا يناسبكِ.', url: url.href };
    try {
      if (navigator.share) await navigator.share(data);
      else if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(data.url);
        announce('نُسخ رابط الاختبار. أرسليه لمن تحبين.');
      } else {
        const input = document.createElement('textarea'); input.value = data.url;
        input.setAttribute('readonly', ''); input.style.position = 'fixed'; input.style.opacity = '0'; document.body.append(input); input.select();
        const copied = document.execCommand('copy'); input.remove();
        announce(copied ? 'نُسخ رابط الاختبار.' : 'يمكنكِ مشاركة رابط هذه الصفحة بعد حذف ما يأتي بعد علامة ؟.');
      }
      track('share');
    } catch (error) { if (error.name !== 'AbortError') announce('لم تكتمل المشاركة. حاولي مجددًا.'); }
  }

  $('start-button').addEventListener('click', start);
  $('restart-button').addEventListener('click', start);
  $('resume-button').addEventListener('click', () => {
    if (Object.keys(state.answers).length === content.questions.length) { renderResult(); screen('result', 'result-name'); }
    else { renderQuestion(); screen('quiz', 'question-title'); }
    track('resume');
  });
  $('exit-button').addEventListener('click', () => { if (transitioning) return; syncIntro(); screen('intro'); });
  $('next-button').addEventListener('click', next);
  $('back-button').addEventListener('click', () => {
    if (transitioning || state.current === 0) return;
    state.current--; renderQuestion(); $('question-title').focus({ preventScroll: true });
  });
  $('edit-answers-button').addEventListener('click', () => { state.current = 0; renderQuestion(); screen('quiz', 'question-title'); });
  $('book-link').addEventListener('click', () => track('book_click', { pattern: result.winner, product: result.productKey }));
  $('dock-link').addEventListener('click', () => track('book_click', { pattern: result.winner, product: result.productKey, placement: 'dock' }));
  $('guide-link').addEventListener('click', () => track('guide_download', { pattern: result.winner }));
  $('whatsapp-link').addEventListener('click', () => track('whatsapp_click', { pattern: result.winner }));
  $('lead-form').addEventListener('submit', submitLead);
  $('share-button').addEventListener('click', share);
  $('save-button').addEventListener('click', () => { track('save_result'); window.print(); });
  $('current-year').textContent = new Date().getFullYear();
  restore();
  syncIntro();
  if (state.screen === 'result') { renderResult(); screen('result'); }
  track('view');
})();
