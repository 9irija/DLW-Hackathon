/**
 * Utilities for splitting and describing source code before it reaches agents.
 */

/**
 * Split source code into overlapping text chunks for embedding.
 * @param {string} code
 * @param {number} chunkSize  characters per chunk
 * @param {number} overlap    characters of overlap between chunks
 * @returns {string[]}
 */
function chunkCode(code, chunkSize = 1500, overlap = 200) {
  const chunks = [];
  let start = 0;
  while (start < code.length) {
    const end = Math.min(start + chunkSize, code.length);
    chunks.push(code.slice(start, end));
    if (end === code.length) break;
    start += chunkSize - overlap;
  }
  return chunks;
}

/**
 * Map a file extension to a language name.
 * @param {string} filePath
 * @returns {string}
 */
function detectLanguage(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  const map = {
    js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
    py: 'python', rb: 'ruby', go: 'go', java: 'java', cs: 'csharp',
    cpp: 'cpp', c: 'c', rs: 'rust', php: 'php', sh: 'bash', md: 'markdown',
  };
  return map[ext] || 'unknown';
}

/**
 * Build a structured payload ready for agents.
 * @param {string} code
 * @param {string} filePath
 * @param {string} [diff]
 * @returns {object}
 */
function buildReviewPayload(code, filePath, diff = null) {
  return {
    filePath,
    language: detectLanguage(filePath),
    code,
    diff,
    chunks: chunkCode(code),
    timestamp: new Date().toISOString(),
  };
}

module.exports = { chunkCode, detectLanguage, buildReviewPayload };
