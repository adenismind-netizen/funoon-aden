'use strict';

const { welcomeText, buildTgAlert } = require('./messages');

class ProviderError extends Error {
  constructor(code, state = 'unknown', retryMs = 0) {
    super(code); this.code = code; this.state = state; this.retryMs = retryMs;
  }
}

function makeProviders(env = process.env, fetchImpl = fetch) {
  const timeoutMs = 10000;
  const configured = {
    save: Boolean(env.SUPABASE_URL && (env.SUPABASE_KEY || env.SUPABASE_SERVICE_ROLE || env.SUPABASE_ANON_KEY)),
    telegram: Boolean(env.TG_TOKEN && env.TG_CHAT),
    whatsapp: Boolean(env.WASENDER_API_KEY)
  };
  async function request(url, options, { json = true } = {}) {
    let response;
    try {
      response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch (_) { throw new ProviderError('network_outcome_unknown'); }
    // A 429 is an explicit rejection and is the only automatic resend condition.
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after'));
      await response.body?.cancel();
      throw new ProviderError('provider_rate_limited', 'queued', Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 3600000) : 60000);
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status >= 400 && response.status < 500) throw new ProviderError('provider_rejected_' + response.status, 'failed');
      throw new ProviderError('provider_outcome_unknown_' + response.status);
    }
    if (!json) { await response.body?.cancel(); return null; }
    let data;
    try {
      // Bound provider output; never retain or log arbitrary error text.
      if (Number(response.headers.get('content-length') || 0) > 65536) throw new Error('large');
      const reader = response.body.getReader();
      let bytes = 0; const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 65536) { await reader.cancel(); throw new Error('large'); }
        chunks.push(Buffer.from(value));
      }
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (_) { throw new ProviderError('invalid_provider_response'); }
    return data;
  }

  const providers = {
    async save(submission) {
      if (!configured.save) throw new ProviderError('save_not_configured', 'failed');
      const key = env.SUPABASE_KEY || env.SUPABASE_SERVICE_ROLE || env.SUPABASE_ANON_KEY;
      const url = new URL(env.SUPABASE_URL);
      if (url.protocol !== 'https:' || url.username || url.password || !/^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname)) throw new ProviderError('bad_supabase_configuration', 'failed');
      const table = env.SUPABASE_TABLE || 'quiz_leads';
      if (table !== 'quiz_leads') throw new ProviderError('bad_table_configuration', 'failed');
      await request(`${url.origin}/rest/v1/quiz_leads`, {
        method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(submission.lead)
      }, { json: false });
      return { state: 'accepted' };
    },
    async telegram(submission) {
      if (!configured.telegram) throw new ProviderError('telegram_not_configured', 'failed');
      const data = await request(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TG_CHAT, text: buildTgAlert(submission), disable_web_page_preview: true })
      });
      if (data.ok === true && Number.isSafeInteger(data.result?.message_id)) return { state: 'accepted', providerId: String(data.result.message_id) };
      if (data.ok === false && data.error_code === 429) throw new ProviderError('provider_rate_limited', 'queued', Math.min(Math.max(Number(data.parameters?.retry_after) || 60, 1), 3600) * 1000);
      if (data.ok === false && Number.isInteger(data.error_code) && data.error_code >= 400 && data.error_code < 500) throw new ProviderError('provider_rejected_' + data.error_code, 'failed');
      throw new ProviderError('invalid_provider_response');
    },
    async whatsapp(submission) {
      if (!configured.whatsapp) throw new ProviderError('whatsapp_not_configured', 'failed');
      const data = await request('https://www.wasenderapi.com/api/send-message', {
        method: 'POST', headers: { Authorization: `Bearer ${env.WASENDER_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: submission.payload.phone, text: welcomeText(submission) })
      });
      // msgId identifies acceptance, not delivery/read status.
      const id = data?.data?.msgId;
      if (data.success === true && (Number.isSafeInteger(id) || (typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)))) return { state: 'accepted', providerId: String(id) };
      throw new ProviderError('invalid_provider_response');
    }
  };
  return { providers, configured };
}

module.exports = { makeProviders, ProviderError };
