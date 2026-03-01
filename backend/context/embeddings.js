const openai = require('../core/openai');

const EMBEDDING_MODEL = 'text-embedding-3-small';

/**
 * Generate an embedding vector for a text string.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function embed(text) {
  if (!text || typeof text !== 'string') {
    throw new TypeError('embed() requires a non-empty string');
  }
  const response = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: text });
  return response.data[0].embedding;
}

/**
 * Cosine similarity between two equal-length vectors.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}  value in [-1, 1]
 */
function cosineSimilarity(a, b) {
  if (a.length !== b.length) throw new Error('Vectors must have the same length');
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

module.exports = { embed, cosineSimilarity };
