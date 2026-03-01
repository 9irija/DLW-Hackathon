/**
 * skeptic — challenges assumptions, questions design decisions, flags
 * missing edge cases and logic errors. Produces per-finding confidence scores.
 *
 * Output shape:
 * {
 *   agent: "skeptic",
 *   status: "pass" | "warn" | "fail",
 *   confidence: number,   // 0–100 overall confidence in the code
 *   findings: [{ line, category, description, severity, confidence, suggestion }],
 *   summary: string
 * }
 */

/**
 * @param {object} payload
 * @param {string}   payload.code
 * @param {string}   payload.filePath
 * @param {string}   payload.language
 * @param {string}   [payload.diff]
 * @param {object[]} [payload.context]
 * @returns {Promise<object>}
 */
async function run(payload) {
  // TODO: implement skeptical analysis with confidence scoring
  return {
    agent: 'skeptic',
    status: 'pass',
    confidence: 100,
    findings: [],
    summary: 'Skeptic agent not yet implemented.',
  };
}

module.exports = { run };
