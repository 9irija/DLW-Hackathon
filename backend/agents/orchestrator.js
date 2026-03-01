/**
 * orchestrator — runs factchecker only for now; aggregates result into verdict.
 *
 * Output shape:
 * {
 *   agent: "orchestrator",
 *   verdict: "approve" | "request-changes" | "block",
 *   score: number,        // 0–100 overall code health
 *   agentResults: { factchecker },
 *   prioritizedFindings: [{ source, ...finding }],
 *   summary: string,
 *   sessionId: string
 * }
 */

const factchecker = require('./factchecker');

/**
 * @param {object} payload  — built by core/parser.js buildReviewPayload()
 * @returns {Promise<object>}
 */
async function run(payload) {
  const factResult = await factchecker.run(payload);

  const findings = (factResult.findings || []).map((f) => ({ source: 'factchecker', ...f }));
  const hasFail = factResult.status === 'fail';
  const hasWarn = factResult.status === 'warn';
  const verdict = hasFail ? 'block' : hasWarn ? 'request-changes' : 'approve';
  const score = hasFail ? 40 : hasWarn ? 70 : 100;

  return {
    agent: 'orchestrator',
    verdict,
    score,
    agentResults: { factchecker: factResult },
    prioritizedFindings: findings,
    summary: factResult.summary || (verdict === 'approve' ? 'Comments match implementation.' : 'Review findings from factchecker.'),
    sessionId: payload.sessionId || null,
  };
}

module.exports = { run };
