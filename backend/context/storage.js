require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { cosineSimilarity } = require('./embeddings');

const DB_PATH = process.env.DB_PATH || './data/audit.db';
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS document_chunks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT    NOT NULL,
      file_path   TEXT    NOT NULL,
      chunk_index INTEGER NOT NULL,
      content     TEXT    NOT NULL,
      embedding   TEXT    NOT NULL
    )
  `);
});

/**
 * Persist a code chunk and its embedding.
 * @param {object} params
 * @param {string}   params.sessionId
 * @param {string}   params.filePath
 * @param {number}   params.chunkIndex
 * @param {string}   params.content
 * @param {number[]} params.embedding
 * @returns {Promise<number>} inserted row id
 */
function storeChunk({ sessionId, filePath, chunkIndex, content, embedding }) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO document_chunks (session_id, file_path, chunk_index, content, embedding)
       VALUES (?, ?, ?, ?, ?)`,
      [sessionId, filePath, chunkIndex, content, JSON.stringify(embedding)],
      function (err) { if (err) return reject(err); resolve(this.lastID); }
    );
  });
}

/**
 * Retrieve the top-K chunks most similar to a query embedding.
 * @param {number[]} queryEmbedding
 * @param {object}  [opts]
 * @param {string}  [opts.sessionId]
 * @param {number}  [opts.topK=5]
 * @returns {Promise<Array<{id, filePath, chunkIndex, content, score}>>}
 */
function retrieveTopChunks(queryEmbedding, { sessionId = null, topK = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const sql = sessionId
      ? `SELECT id, file_path, chunk_index, content, embedding FROM document_chunks WHERE session_id = ?`
      : `SELECT id, file_path, chunk_index, content, embedding FROM document_chunks`;
    const params = sessionId ? [sessionId] : [];
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      const scored = rows.map((row) => ({
        id: row.id,
        filePath: row.file_path,
        chunkIndex: row.chunk_index,
        content: row.content,
        score: cosineSimilarity(queryEmbedding, JSON.parse(row.embedding)),
      }));
      scored.sort((a, b) => b.score - a.score);
      resolve(scored.slice(0, topK));
    });
  });
}

/**
 * Delete all chunks for a session (post-review cleanup).
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
function clearSession(sessionId) {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM document_chunks WHERE session_id = ?`, [sessionId],
      (err) => { if (err) return reject(err); resolve(); }
    );
  });
}

module.exports = { storeChunk, retrieveTopChunks, clearSession, db };
