/**
 * orchestrator — coordinates all agents in parallel, aggregates results,
 * and issues a final verdict.
 *
 * Output shape:
 * {
 *   agent: "orchestrator",
 *   verdict: "approve" | "request-changes" | "block",
 *   score: number,        // 0–100 overall code health
 *   agentResults: { factchecker, attacker, skeptic, builder },
 *   prioritizedFindings: [{ source, ...finding }],
 *   summary: string,
 *   sessionId: string
 * }
 */

const factchecker = require('./factchecker');
const attacker    = require('./attacker');
const skeptic     = require('./skeptic');
const builder     = require('./builder');

/**
 * @param {object} payload  — built by core/parser.js buildReviewPayload()
 * @returns {Promise<object>}
 */
async function run(payload) {
  // TODO: aggregate results, score, and prioritize findings
  const [factResult, attackResult, skepticResult, builderResult] = await Promise.all([
    factchecker.run(payload),
    attacker.run(payload),
    skeptic.run(payload),
    builder.run(payload),
  ]);

  return {
    agent: 'orchestrator',
    verdict: 'approve',
    score: 100,
    agentResults: {
      factchecker: factResult,
      attacker:    attackResult,
      skeptic:     skepticResult,
      builder:     builderResult,
    },
    prioritizedFindings: [],
    summary: 'Orchestrator not yet implemented — agent stubs returned.',
    sessionId: payload.sessionId || null,
  };
}

module.exports = { run };
