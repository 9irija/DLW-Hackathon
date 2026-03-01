/**
 * orchestrator — runs factchecker and skeptic; aggregates result into verdict.
 *
 * Output shape:
 * {
 *   agent: "orchestrator",
 *   verdict: "approve" | "request-changes" | "block",
 *   score: number,
 *   agentResults: { factchecker, skeptic },
 *   prioritizedFindings: [{ source, ...finding }],
 *   summary: string,
 *   sessionId: string
 * }
 */

const factchecker = require('./factchecker');
const skeptic = require('./skeptic');

/**
 * @param {object} payload  — built by core/parser.js buildReviewPayload()
 * @returns {Promise<object>}
 */
async function run(payload) {
  const factResult = await factchecker.run(payload);
  const skepticResult = await skeptic.run(payload);

  const findings = (factResult.findings || []).map((f) => ({ source: 'factchecker', ...f }));
  (skepticResult.findings || []).forEach((f) => findings.push({ source: 'skeptic', ...f }));

  const hasFail = factResult.status === 'fail' || skepticResult.status === 'fail';
  const hasWarn = factResult.status === 'warn' || skepticResult.status === 'warn';
  const verdict = hasFail ? 'block' : hasWarn ? 'request-changes' : 'approve';
  const score = hasFail ? 40 : hasWarn ? 70 : 100;

  const summaryParts = [factResult.summary, skepticResult.summary].filter(Boolean);
  return {
    agent: 'orchestrator',
    verdict,
    score,
    agentResults: { factchecker: factResult, skeptic: skepticResult },
    prioritizedFindings: findings,
    summary: summaryParts.length ? summaryParts.join(' ') : 'Review complete.',
    sessionId: payload.sessionId || null,
  };
}

module.exports = { run };
