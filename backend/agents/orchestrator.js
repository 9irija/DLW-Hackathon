/**
 * orchestrator — runs Builder → Fact Checker → Skeptic; aggregates result into verdict.
 *
 * Output shape:
 * {
 *   agent: "orchestrator",
 *   verdict: "approve" | "request-changes" | "block",
 *   score: number,
 *   agentResults: { builder, factchecker, skeptic },
 *   prioritizedFindings: [{ source, ...finding }],
 *   summary: string,
 *   sessionId: string,
 *   codeContext?: object  (from Builder, for downstream use)
 * }
 */

const builder = require('./builder');
const factchecker = require('./factchecker');
const skeptic = require('./skeptic');

/**
 * @param {object} payload  — built by core/parser.js buildReviewPayload()
 * @returns {Promise<object>}
 */
async function run(payload) {
  // 1. Builder runs first — provides CodeContext for downstream
  const builderResult = await builder.run(payload);
  const enrichedPayload = { ...payload };
  if (builderResult.codeContext) {
    enrichedPayload.codeContext = builderResult.codeContext;
  }

  // 2. Fact Checker and Skeptic run with enriched payload
  const factResult = await factchecker.run(enrichedPayload);
  const skepticResult = await skeptic.run(enrichedPayload);

  const findings = (builderResult.findings || []).map((f) => ({ source: 'builder', ...f }));
  (factResult.findings || []).forEach((f) => findings.push({ source: 'factchecker', ...f }));
  (skepticResult.findings || []).forEach((f) => findings.push({ source: 'skeptic', ...f }));

  const hasFail = builderResult.status === 'fail' || factResult.status === 'fail' || skepticResult.status === 'fail';
  const hasWarn = builderResult.status === 'warn' || factResult.status === 'warn' || skepticResult.status === 'warn';
  const verdict = hasFail ? 'block' : hasWarn ? 'request-changes' : 'approve';
  const score = hasFail ? 40 : hasWarn ? 70 : 100;

  const summaryParts = [builderResult.summary, factResult.summary, skepticResult.summary].filter(Boolean);
  const result = {
    agent: 'orchestrator',
    verdict,
    score,
    agentResults: { builder: builderResult, factchecker: factResult, skeptic: skepticResult },
    prioritizedFindings: findings,
    summary: summaryParts.length ? summaryParts.join(' ') : 'Review complete.',
    sessionId: payload.sessionId || null,
  };
  if (builderResult.codeContext) result.codeContext = builderResult.codeContext;
  return result;
}

module.exports = { run };
