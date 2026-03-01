require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || './data/audit.db';

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Failed to open audit database:', err.message);
    throw err;
  }
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp      TEXT    NOT NULL,
      agent_name     TEXT    NOT NULL,
      findings       TEXT    NOT NULL,
      human_decision TEXT,
      session_id     TEXT,
      file_path      TEXT
    )
  `);
});

/**
 * Write one agent result to the audit log.
 *
 * @param {object} entry
 * @param {string}        entry.agentName
 * @param {object|string} entry.findings
 * @param {string}        [entry.humanDecision]
 * @param {string}        [entry.sessionId]
 * @param {string}        [entry.filePath]
 * @returns {Promise<number>} inserted row id
 */
function logEntry({ agentName, findings, humanDecision = null, sessionId = null, filePath = null }) {
  return new Promise((resolve, reject) => {
    const timestamp  = new Date().toISOString();
    const findingsStr = typeof findings === 'string' ? findings : JSON.stringify(findings);
    db.run(
      `INSERT INTO audit_log (timestamp, agent_name, findings, human_decision, session_id, file_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [timestamp, agentName, findingsStr, humanDecision, sessionId, filePath],
      function (err) { if (err) return reject(err); resolve(this.lastID); }
    );
  });
}

/**
 * Update the human decision on a previously logged row.
 * @param {number} id
 * @param {string} humanDecision  "accept" | "reject" | "defer"
 */
function updateDecision(id, humanDecision) {
  return new Promise((resolve, reject) => {
    db.run(`UPDATE audit_log SET human_decision = ? WHERE id = ?`, [humanDecision, id],
      (err) => { if (err) return reject(err); resolve(); }
    );
  });
}

/** @returns {Promise<object[]>} */
function getEntries(limit = 100) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ?`, [limit],
      (err, rows) => { if (err) return reject(err); resolve(rows); }
    );
  });
}

module.exports = { logEntry, updateDecision, getEntries, db };
