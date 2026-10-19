'use strict';
// Read-only operational summary; no names, phone numbers, payloads or provider IDs.
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const db = new DatabaseSync(process.env.DB_PATH || path.join(process.env.DATA_DIR || path.join(__dirname, '../data'), 'quiz.db'), { readOnly: true });
console.log(JSON.stringify(db.prepare('SELECT kind,state,COUNT(*) AS count FROM quiz_outbox_v2 GROUP BY kind,state ORDER BY kind,state').all(), null, 2));
db.close();
