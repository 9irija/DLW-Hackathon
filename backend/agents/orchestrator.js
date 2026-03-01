'use strict';

/**
 * orchestrator — Central Controller
 *
 * Pipeline (matches product spec):
 *
 *   PHASE 1 — Builder runs first
 *     builder.run(payload)
 *       → produces codeContext: { intent, entryPoints, dependencies,
 *                                 externalCalls, sideEffects, dataFlows,
 *                                 potentialRisks, submissionId }
 *       → enriched payload sent to all downstream agents
 *
 *   PHASE 2 — Downstream agents run in parallel (enriched payload)
 *     factchecker.run(enrichedPayload)   → { findings[{line,claim,reality,severity,suggestion}], status, summary }
 *     attacker.run(enrichedPayload)      → { findings[{line,type,description,severity,cwe,suggestion}], status, summary }
 *     skeptic.run(enrichedPayload)       → { findings[{line,category,description,severity,confidence,suggestion}], evidence, flow, status, summary }
 *
 *   PHASE 3 — Builder challenge loop (critical findings only, saves credits)
 *     For each critical finding from factchecker or attacker:
 *       builder.respondToChallenge(codeContext, finding)
 *         → { assessment: "acknowledged"|"disputed"|"requires_fix", proposedFix }
 *       Attach response to finding as challengeResponse
 *
 *   PHASE 4 — Aggregate
 *     Normalize all findings to common shape
 *     Deduplicate same-line + same-type across agents
 *     Sort: severity desc → confidence desc
 *     Calculate score (100 - deductions)
 *     Determine verdict
 *     Build summary
 *
 * Verdict precedence:
 *   block           → any critical finding  OR  any confirmed PoC exploit
 *   request-changes → any high finding      OR  attacker/factchecker status = fail
 *   approve         → medium/low only, all agents pass or warn
 *
 * Score deductions (floor 0):
 *   critical : -25  |  high : -15  |  medium : -5  |  low : -2
 *   confirmed PoC exploit: additional -10 each
 *
 * Output shape:
 * {
 *   agent:               "orchestrator",
 *   verdict:             "approve" | "request-changes" | "block",
 *   score:               number,
 *   agentResults:        { builder, factchecker, attacker, skeptic },
 *   agentStatuses:       { builder: "pass"|"warn"|"fail"|"error", ... },
 *   prioritizedFindings: [ normalized + deduplicated findings ],
 *   challengeResponses:  [ { finding, response } ],   // builder defences
 *   summary:             string,
 *   sessionId:           string | null
 * }
 */

const builderAgent    = require('./builder');
const factchecker     = require('./factchecker');
const attacker        = require('./attacker');
const skeptic         = require('./skeptic');

// ─── Severity ─────────────────────────────────────────────────────────────────

const SEVERITY_RANK       = { critical: 4, high: 3, medium: 2, low: 1 };
const SCORE_DEDUCTIONS    = { critical: 25, high: 15, medium: 5, low: 2 };
const AGENT_PRIORITY      = { attacker: 4, skeptic: 3, factchecker: 2, builder: 1 };

// ─── Safe runner ──────────────────────────────────────────────────────────────

async function safeRun(agentModule, agentName, payload) {
  try {
    return { ok: true, result: await agentModule.run(payload) };
  } catch (err) {
    console.error(`[orchestrator] ${agentName} threw:`, err.message);
    return {
      ok: false,
      result: {
        agent:    agentName,
        status:   'error',
        findings: [],
        summary:  `${agentName} failed to run: ${err.message}`,
      },
    };
  }
}

// ─── Finding normalisation ────────────────────────────────────────────────────

/**
 * Normalise one raw finding from any agent into a common shape.
 * Preserves all agent-specific fields (cwe, claim, exploitProof, etc.).
 */
function normalise(f, agentName) {
  return {
    source:      agentName,
    line:        f.line ?? null,
    // factchecker uses 'claim', others use 'description' or 'type'
    type:        f.type || f.category || 'issue',
    description: f.description || f.claim || f.type || '',
    severity:    ['critical', 'high', 'medium', 'low'].includes(f.severity)
                   ? f.severity : 'low',
    suggestion:  f.suggestion || '',
    // preserve agent-specific extras
    ...(f.claim         != null && { claim:         f.claim         }),
    ...(f.reality       != null && { reality:       f.reality       }),
    ...(f.cwe           != null && { cwe:           f.cwe           }),
    ...(f.attackVector  != null && { attackVector:  f.attackVector  }),
    ...(f.impact        != null && { impact:        f.impact        }),
    ...(f.confidence    != null && { confidence:    f.confidence    }),
    ...(f.category      != null && { category:      f.category      }),
    ...(f.exploitProof  != null && { exploitProof:  f.exploitProof  }),
    // factchecker doc-review: which external document raised this finding
    ...(f.docSource     != null && { docSource:     f.docSource     }),
  };
}

function normaliseAll(findings, agentName) {
  return (findings || []).map(f => normalise(f, agentName));
}

// ─── Deduplication ────────────────────────────────────────────────────────────

/**
 * Remove duplicate findings (same line + same normalised type).
 * When duplicates exist, keep the one with highest severity,
 * breaking ties by agent priority.
 */
function deduplicate(findings) {
  const map    = new Map();   // key → index in result
  const result = [];

  findings.forEach(f => {
    const typeKey = (f.type || '').toLowerCase().replace(/\s+/g, '-');
    if (f.line == null) { result.push(f); return; }

    const key = `${f.line}::${typeKey}`;
    if (!map.has(key)) {
      map.set(key, result.length);
      result.push(f);
    } else {
      const idx = map.get(key);
      const existing = result[idx];
      const fRank  = SEVERITY_RANK[f.severity]        ?? 0;
      const eRank  = SEVERITY_RANK[existing.severity] ?? 0;
      const fPri   = AGENT_PRIORITY[f.source]         ?? 0;
      const ePri   = AGENT_PRIORITY[existing.source]  ?? 0;
      if (fRank > eRank || (fRank === eRank && fPri > ePri)) result[idx] = f;
    }
  });

  return result;
}

function sortFindings(findings) {
  return [...findings].sort((a, b) => {
    const s = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
    return s !== 0 ? s : (b.confidence ?? 0) - (a.confidence ?? 0);
  });
}

// ─── Builder challenge loop ───────────────────────────────────────────────────

/**
 * For every critical finding from factchecker or attacker, ask builder
 * to defend or acknowledge the issue (per the product spec).
 * Runs in parallel; failures are silent.
 */
async function runChallengeLoop(codeContext, findings) {
  if (!codeContext) return [];

  const critical = findings.filter(
    f => f.severity === 'critical' &&
         (f.source === 'factchecker' || f.source === 'attacker')
  );
  if (!critical.length) return [];

  const responses = await Promise.all(
    critical.map(async f => {
      try {
        const response = await builderAgent.respondToChallenge(codeContext, {
          agentName: f.source,
          finding:   f.description,
          severity:  f.severity,
        });
        return { finding: f, response };
      } catch {
        return null;
      }
    })
  );

  return responses.filter(Boolean);
}

// ─── Scoring & verdict ────────────────────────────────────────────────────────

function calculateScore(findings, attackerResult) {
  let score = 100;
  findings.forEach(f => { score -= SCORE_DEDUCTIONS[f.severity] ?? 0; });

  // Extra penalty for PoC-confirmed exploits
  const confirmed = (attackerResult?.findings || [])
    .filter(f => f.exploitProof?.confirmed).length;
  score -= confirmed * 10;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function determineVerdict(findings, agentResults) {
  const hasCritical      = findings.some(f => f.severity === 'critical');
  const hasHigh          = findings.some(f => f.severity === 'high');
  const confirmedExploit = (agentResults.attacker?.findings || [])
    .some(f => f.exploitProof?.confirmed);
  const attackerFailed   = agentResults.attacker?.status    === 'fail';
  const factFailed       = agentResults.factchecker?.status === 'fail';

  if (hasCritical || confirmedExploit)          return 'block';
  if (hasHigh || attackerFailed || factFailed)  return 'request-changes';
  return 'approve';
}

// ─── Summary ──────────────────────────────────────────────────────────────────

function buildSummary(verdict, score, findings, agentResults, codeContext, challengeResponses) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  findings.forEach(f => { if (counts[f.severity] !== undefined) counts[f.severity]++; });

  const confirmed = (agentResults.attacker?.findings || [])
    .filter(f => f.exploitProof?.confirmed).length;

  const verdictLine = {
    'block':           'BLOCK — do not merge.',
    'request-changes': 'REQUEST CHANGES — issues must be addressed before merge.',
    'approve':         'APPROVE — no blocking issues found.',
  }[verdict];

  const countStr = [
    counts.critical && `${counts.critical} critical`,
    counts.high     && `${counts.high} high`,
    counts.medium   && `${counts.medium} medium`,
    counts.low      && `${counts.low} low`,
  ].filter(Boolean).join(', ');

  const parts = [
    `${verdictLine} Score: ${score}/100.`,
    countStr
      ? `${countStr} finding(s) found.${confirmed ? ` ${confirmed} PoC-confirmed.` : ''}`
      : 'No findings detected.',
  ];

  // Builder intent (human-readable context)
  if (codeContext?.intent) {
    parts.push(`Code intent: ${codeContext.intent.slice(0, 120)}${codeContext.intent.length > 120 ? '…' : ''}`);
  }

  // Agent status line
  const statusLine = Object.entries(agentResults)
    .map(([n, r]) => `${n}:${r?.status ?? 'unknown'}`)
    .join(' | ');
  parts.push(`Agents — ${statusLine}.`);

  // Challenge responses
  const acknowledged = (challengeResponses || [])
    .filter(c => c.response?.challengeResponse?.assessment !== 'disputed').length;
  if (challengeResponses?.length) {
    parts.push(`Builder responded to ${challengeResponses.length} critical finding(s); ${acknowledged} acknowledged.`);
  }

  return parts.join(' ');
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

/**
 * @param {object} payload — from core/parser.js buildReviewPayload()
 * @returns {Promise<object>}
 */
async function run(payload) {

  // ── Phase 1: Builder first ──────────────────────────────────────────────────
  const { result: builderResult } = await safeRun(builderAgent, 'builder', payload);
  const codeContext = builderResult.codeContext ?? null;

  // Enrich payload: downstream agents receive builder's code analysis as context
  const enrichedPayload = {
    ...payload,
    codeContext,
    // Prepend builder's potential risks as extra context string for prompts
    builderContext: codeContext
      ? `Code intent: ${codeContext.intent || 'unknown'}. ` +
        `Entry points: ${(codeContext.entryPoints || []).join(', ') || 'none'}. ` +
        `Potential risks flagged by builder: ${(codeContext.potentialRisks || []).join('; ') || 'none'}.`
      : null,
  };

  // ── Phase 2: Downstream agents in parallel ──────────────────────────────────
  const [
    { result: factResult },
    { result: attackResult },
    { result: skepticResult },
  ] = await Promise.all([
    safeRun(factchecker, 'factchecker', enrichedPayload),
    safeRun(attacker,    'attacker',    enrichedPayload),
    safeRun(skeptic,     'skeptic',     enrichedPayload),
  ]);

  const agentResults = {
    builder:     builderResult,
    factchecker: factResult,
    attacker:    attackResult,
    skeptic:     skepticResult,
  };

  const agentStatuses = Object.fromEntries(
    Object.entries(agentResults).map(([k, v]) => [k, v?.status ?? 'unknown'])
  );

  // ── Phase 3: Normalise + merge all findings ─────────────────────────────────
  const allFindings = [
    ...normaliseAll(builderResult.findings,  'builder'),
    ...normaliseAll(factResult.findings,     'factchecker'),
    ...normaliseAll(attackResult.findings,   'attacker'),
    ...normaliseAll(skepticResult.findings,  'skeptic'),
  ];

  const prioritizedFindings = sortFindings(deduplicate(allFindings));

  // ── Phase 4: Builder challenge loop (critical findings only) ─────────────────
  const challengeResponses = await runChallengeLoop(codeContext, prioritizedFindings);

  // Attach challenge responses back onto the relevant findings
  challengeResponses.forEach(({ finding, response }) => {
    const match = prioritizedFindings.find(
      f => f.source === finding.source &&
           f.line   === finding.line   &&
           f.description === finding.description
    );
    if (match) match.challengeResponse = response.challengeResponse ?? null;
  });

  // ── Phase 5: Score + verdict + summary ────────────────────────────────────
  const score   = calculateScore(prioritizedFindings, attackResult);
  const verdict = determineVerdict(prioritizedFindings, agentResults);
  const summary = buildSummary(
    verdict, score, prioritizedFindings,
    agentResults, codeContext, challengeResponses
  );

  return {
    agent:               'orchestrator',
    verdict,
    score,
    agentResults,
    agentStatuses,
    prioritizedFindings,
    challengeResponses,
    summary,
    sessionId: payload.sessionId || null,
  };
}

// ─── Stepped-review: Builder start ───────────────────────────────────────────

/**
 * Step 1 of the human-in-the-loop flow.
 * Runs Builder (Phase 1) and returns the enriched payload so downstream
 * agents receive builder context. index.js stores this in the session.
 *
 * @param {object} payload — from core/parser.js buildReviewPayload()
 * @returns {Promise<{ builderResult, enrichedPayload }>}
 */
async function startReview(payload) {
  const { result: builderResult } = await safeRun(builderAgent, 'builder', payload);
  const codeContext = builderResult.codeContext ?? null;

  const enrichedPayload = {
    ...payload,
    codeContext,
    builderContext: codeContext
      ? `Code intent: ${codeContext.intent || 'unknown'}. ` +
        `Entry points: ${(codeContext.entryPoints || []).join(', ') || 'none'}. ` +
        `Potential risks flagged by builder: ${(codeContext.potentialRisks || []).join('; ') || 'none'}.`
      : null,
  };

  return { builderResult, enrichedPayload };
}

// ─── Stepped-review: run one downstream agent ────────────────────────────────

const AGENT_MAP = { factchecker, attacker, skeptic };

/**
 * Runs a single named downstream agent using the enriched payload
 * (which already includes builder context from startReview).
 *
 * @param {string} agentName — 'factchecker' | 'attacker' | 'skeptic'
 * @param {object} enrichedPayload
 * @returns {Promise<object>} agent result
 */
async function runAgent(agentName, enrichedPayload) {
  const agentModule = AGENT_MAP[agentName];
  if (!agentModule) throw new Error(`Unknown agent: ${agentName}`);
  const { result } = await safeRun(agentModule, agentName, enrichedPayload);
  return result;
}

// ─── Stepped-review finalizer ─────────────────────────────────────────────────

/**
 * Finalize a stepped review given already-collected agent results.
 * Runs phases 3-5 (normalise, deduplicate, challenge loop, score, verdict).
 * Agents that did not run contribute empty findings.
 *
 * @param {object} agentResults  — { builder?, factchecker?, attacker?, skeptic? }
 * @param {object} payload       — original review payload (for sessionId, filePath)
 */
async function finalize(agentResults, payload) {
  const builderResult  = agentResults.builder     || { agent: 'builder',     status: 'skipped', findings: [] };
  const factResult     = agentResults.factchecker  || { agent: 'factchecker', status: 'skipped', findings: [] };
  const attackResult   = agentResults.attacker     || { agent: 'attacker',    status: 'skipped', findings: [] };
  const skepticResult  = agentResults.skeptic      || { agent: 'skeptic',     status: 'skipped', findings: [] };

  const codeContext = builderResult.codeContext ?? null;

  const allAgentResults = { builder: builderResult, factchecker: factResult, attacker: attackResult, skeptic: skepticResult };
  const agentStatuses   = Object.fromEntries(
    Object.entries(allAgentResults).map(([k, v]) => [k, v?.status ?? 'unknown'])
  );

  const allFindings = [
    ...normaliseAll(builderResult.findings,  'builder'),
    ...normaliseAll(factResult.findings,     'factchecker'),
    ...normaliseAll(attackResult.findings,   'attacker'),
    ...normaliseAll(skepticResult.findings,  'skeptic'),
  ];

  const prioritizedFindings = sortFindings(deduplicate(allFindings));
  const challengeResponses  = await runChallengeLoop(codeContext, prioritizedFindings);

  challengeResponses.forEach(({ finding, response }) => {
    const match = prioritizedFindings.find(
      f => f.source === finding.source && f.line === finding.line && f.description === finding.description
    );
    if (match) match.challengeResponse = response.challengeResponse ?? null;
  });

  const score   = calculateScore(prioritizedFindings, attackResult);
  const verdict = determineVerdict(prioritizedFindings, allAgentResults);
  const summary = buildSummary(verdict, score, prioritizedFindings, allAgentResults, codeContext, challengeResponses);

  return {
    agent: 'orchestrator',
    verdict,
    score,
    agentResults:        allAgentResults,
    agentStatuses,
    prioritizedFindings,
    challengeResponses,
    summary,
    sessionId: payload?.sessionId || null,
  };
}

module.exports = { run, startReview, runAgent, finalize };
