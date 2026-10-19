'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

class Store {
  constructor(filename, { now = Date.now, hashKey = '', limits = {} } = {}) {
    this.now = now;
    this.hashKey = hashKey;
    this.limits = { ipHour: 5, globalHour: 100, globalDay: 500, phoneCooldownMs: 21600000, ...limits };
    if (filename !== ':memory:') {
      fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') fs.chmodSync(filename, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS quiz_submissions_v2 (
        id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, phone_hash TEXT NOT NULL,
        ip_hash TEXT NOT NULL, created_at INTEGER NOT NULL, payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS quiz_v2_phone ON quiz_submissions_v2(phone_hash, created_at);
      CREATE INDEX IF NOT EXISTS quiz_v2_ip ON quiz_submissions_v2(ip_hash, created_at);
      CREATE INDEX IF NOT EXISTS quiz_v2_time ON quiz_submissions_v2(created_at);
      CREATE TABLE IF NOT EXISTS quiz_outbox_v2 (
        id INTEGER PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES quiz_submissions_v2(id),
        kind TEXT NOT NULL CHECK(kind IN ('save','telegram','whatsapp')),
        state TEXT NOT NULL CHECK(state IN ('queued','processing','accepted','failed','unknown')),
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        provider_id TEXT, error_code TEXT, UNIQUE(submission_id, kind)
      );
      CREATE INDEX IF NOT EXISTS quiz_v2_jobs ON quiz_outbox_v2(state, next_at);
      CREATE TABLE IF NOT EXISTS quiz_worker_meta_v2 (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    `);
    // A process may have died after provider acceptance but before persisting it.
    // Such jobs require reconciliation; restarting must never blindly resend them.
    this.db.prepare("UPDATE quiz_outbox_v2 SET state='unknown', error_code='process_interrupted', updated_at=? WHERE state='processing'").run(this.now());
  }

  hash(value) { return crypto.createHmac('sha256', this.hashKey || 'aden-quiz-v2').update(value).digest('hex'); }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  accept(submission, ip) {
    return this.transaction(() => {
      const timestamp = this.now();
      const { submissionId } = submission.payload;
      const existing = this.db.prepare('SELECT payload_hash FROM quiz_submissions_v2 WHERE id=?').get(submissionId);
      if (existing) return existing.payload_hash === submission.payloadHash ? { accepted: true, replay: true } : { error: 'idempotency_conflict', status: 409 };
      const phoneHash = this.hash(submission.payload.phone);
      const ipHash = this.hash(ip);
      const count = (where, ...params) => this.db.prepare('SELECT COUNT(*) AS count FROM quiz_submissions_v2 WHERE ' + where).get(...params).count;
      if (count('phone_hash=? AND created_at>?', phoneHash, timestamp - this.limits.phoneCooldownMs)) return { error: 'phone_cooldown', status: 429 };
      if (count('ip_hash=? AND created_at>?', ipHash, timestamp - 3600000) >= this.limits.ipHour ||
          count('created_at>?', timestamp - 3600000) >= this.limits.globalHour ||
          count('created_at>?', timestamp - 86400000) >= this.limits.globalDay) return { error: 'rate_limited', status: 429 };
      this.db.prepare('INSERT INTO quiz_submissions_v2 VALUES (?,?,?,?,?,?)').run(submissionId, submission.payloadHash, phoneHash, ipHash, timestamp, JSON.stringify(submission));
      const insert = this.db.prepare("INSERT INTO quiz_outbox_v2 (submission_id,kind,state,next_at,updated_at) VALUES (?,?,'queued',?,?)");
      for (const kind of ['save', 'telegram', 'whatsapp']) insert.run(submissionId, kind, timestamp, timestamp);
      return { accepted: true, replay: false };
    });
  }

  claim(kind) {
    return this.transaction(() => {
      const timestamp = this.now();
      if (kind === 'whatsapp') {
        const last = this.db.prepare("SELECT value FROM quiz_worker_meta_v2 WHERE key='whatsapp_next_at'").get();
        if (last && last.value > timestamp) return null;
      }
      const job = this.db.prepare("SELECT j.*, s.payload_json FROM quiz_outbox_v2 j JOIN quiz_submissions_v2 s ON s.id=j.submission_id WHERE j.kind=? AND j.state='queued' AND j.next_at<=? ORDER BY j.id LIMIT 1").get(kind, timestamp);
      if (!job) return null;
      this.db.prepare("UPDATE quiz_outbox_v2 SET state='processing', attempts=attempts+1, updated_at=? WHERE id=? AND state='queued'").run(timestamp, job.id);
      if (kind === 'whatsapp') this.db.prepare("INSERT INTO quiz_worker_meta_v2 VALUES ('whatsapp_next_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(timestamp + 6000);
      return { ...job, attempts: job.attempts + 1, submission: JSON.parse(job.payload_json) };
    });
  }

  finish(job, outcome) {
    const state = outcome.state;
    if (!['queued', 'accepted', 'failed', 'unknown'].includes(state)) throw new Error('bad_job_state');
    this.db.prepare("UPDATE quiz_outbox_v2 SET state=?,next_at=?,updated_at=?,provider_id=?,error_code=? WHERE id=? AND state='processing'").run(state, this.now() + (outcome.retryMs || 0), this.now(), outcome.providerId || null, outcome.code || null, job.id);
  }

  jobs(submissionId) {
    return this.db.prepare('SELECT kind,state,attempts,provider_id,error_code FROM quiz_outbox_v2 WHERE submission_id=? ORDER BY kind').all(submissionId);
  }
  close() { this.db.close(); }
}

module.exports = { Store };
