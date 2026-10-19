'use strict';
// Explicitly read-only. No sendMessage, send-message, or lead INSERT is performed.
async function check(name, url, options = {}) {
  try {
    const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) });
    const data = await response.json();
    const ok = response.ok && (name === 'whatsapp' ? data.status === 'connected' : data.ok === true);
    console.log(JSON.stringify({ provider: name, ok, httpStatus: response.status, ...(name === 'whatsapp' ? { connected: data.status === 'connected' } : {}) }));
    return ok;
  } catch (_) { console.log(JSON.stringify({ provider: name, ok: false, error: 'read_check_failed' })); return false; }
}
(async () => {
  if (!process.env.TG_TOKEN || !process.env.TG_CHAT || !process.env.WASENDER_API_KEY) {
    console.log(JSON.stringify({ ok: false, error: 'missing_configuration' })); process.exitCode = 1; return;
  }
  const base = `https://api.telegram.org/bot${process.env.TG_TOKEN}`;
  const results = await Promise.all([
    check('telegram_bot', base + '/getMe'),
    check('telegram_chat', base + '/getChat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: process.env.TG_CHAT }) }),
    check('whatsapp', 'https://www.wasenderapi.com/api/status', { headers: { Authorization: `Bearer ${process.env.WASENDER_API_KEY}` } })
  ]);
  if (results.some(value => !value)) process.exitCode = 1;
})();
