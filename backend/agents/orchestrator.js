'use strict';

const factchecker  = require('./factchecker');
const attacker     = require('./attacker');
const skeptic      = require('./skeptic');
const parser       = require('./parser');
const reasoner     = require('./reasoner');
const docreader    = require('./docreader');

// ─── Constants ────────────────────────────────────────────────────────────────

const SEVERITY_RANK    = { critical: 4, high: 3, medium: 2, low: 1 };
const SCORE_DEDUCTIONS = { critical: 25, high: 15, medium: 5, low: 2 };
const AGENT_PRIORITY   = { attacker: 4, skeptic: 3, factchecker: 2, reasoner: 1 };

/** All runnable agents — used by runAgent() */
const AGENT_MODULES = {
  factchecker,
  attacker,
  skeptic,
  parser,    // auxiliary
  reasoner,  // auxiliary
  docreader, // auxiliary
};

const AGENT_ORDER = ['factchecker', 'attacker', 'skeptic'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function skippedResult(agentName, reason = 'Agent was not run in this review path.') {
  return { agent: agentName, status: 'skipped', findings: [], summary: reason };
}

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

function normalise(f, agentName) {
  return {
    source:      agentName,
    line:        f.line ?? null,
    type:        f.type || f.category || 'issue',
    description: f.description || f.claim || f.type || '',
    severity:    ['critical', 'high', 'medium', 'low'].includes(f.severity) ? f.severity : 'low',
    suggestion:  f.suggestion || '',
    ...(f.claim        != null && { claim:        f.claim        }),
    ...(f.reality      != null && { reality:      f.reality      }),
    ...(f.cwe          != null && { cwe:          f.cwe          }),
    ...(f.attackVector != null && { attackVector: f.attackVector }),
    ...(f.impact       != null && { impact:       f.impact       }),
    ...(f.confidence   != null && { confidence:   f.confidence   }),
    ...(f.category     != null && { category:     f.category     }),
    ...(f.exploitProof != null && { exploitProof: f.exploitProof }),
    ...(f.docSource    != null && { docSource:    f.docSource    }),
    ...(f.docSection   != null && { docSection:   f.docSection   }),
  };
}

function normaliseAll(findings, agentName) {
  return (findings || []).map(f => normalise(f, agentName));
}

// ─── Deduplication ────────────────────────────────────────────────────────────

function deduplicate(findings) {
  const map    = new Map();
  const result = [];

  findings.forEach(f => {
    const typeKey = (f.type || '').toLowerCase().replace(/\s+/g, '-');
    // Doc findings have no line number — always keep them all
    if (f.line == null) { result.push(f); return; }

    const key = `${f.line}::${typeKey}`;
    if (!map.has(key)) {
      map.set(key, result.length);
      result.push(f);
      return;
    }
    const idx      = map.get(key);
    const existing = result[idx];
    const fRank    = SEVERITY_RANK[f.severity]        ?? 0;
    const eRank    = SEVERITY_RANK[existing.severity] ?? 0;
    const fPri     = AGENT_PRIORITY[f.source]         ?? 0;
    const ePri     = AGENT_PRIORITY[existing.source]  ?? 0;
    if (fRank > eRank || (fRank === eRank && fPri > ePri)) result[idx] = f;
  });

  return result;
}

function sortFindings(findings) {
  return [...findings].sort((a, b) => {
    const s = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
    return s !== 0 ? s : (b.confidence ?? 0) - (a.confidence ?? 0);
  });
}

// ─── Pre-processing pipeline (Parser → Reasoner) ─────────────────────────────

/**
 * Run the Parser then the Reasoner and return the Reasoner's result.
 * This replaces the old builder.js wrapper.
 */
async function runPreprocessingPipeline(payload) {
  let parserResult;
  try {
    parserResult = await parser.run(payload);
  } catch (err) {
    parserResult = { agent: 'parser', status: 'fail', parsed: [], findings: [], summary: err.message };
  }
  const reasonerPayload = { ...payload, parsed: parserResult.parsed || [] };
  const { result } = await safeRun(reasoner, 'reasoner', reasonerPayload);
  return result;
}

// ─── Challenge loop ───────────────────────────────────────────────────────────

async function runChallengeLoop(codeContext, findings) {
  if (!codeContext) return [];
  const critical = findings.filter(
    f => f.severity === 'critical' && (f.source === 'factchecker' || f.source === 'attacker')
  );
  if (!critical.length) return [];

  const responses = await Promise.all(
    critical.map(async f => {
      try {
        const response = await reasoner.respondToChallenge(codeContext, {
          agentName: f.source,
          finding:   f.description,
          severity:  f.severity,
        });
        return { finding: f, response };
      } catch { return null; }
    })
  );
  return responses.filter(Boolean);
}

// ─── Scoring & verdict ────────────────────────────────────────────────────────

function calculateScore(findings, attackerResult) {
  let score = 100;
  findings.forEach(f => { score -= SCORE_DEDUCTIONS[f.severity] ?? 0; });
  const confirmed = (attackerResult?.findings || []).filter(f => f.exploitProof?.confirmed).length;
  score -= confirmed * 10;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function determineVerdict(findings, agentResults) {
  const hasCritical      = findings.some(f => f.severity === 'critical');
  const hasHigh          = findings.some(f => f.severity === 'high');
  const confirmedExploit = (agentResults.attacker?.findings || []).some(f => f.exploitProof?.confirmed);
  const attackerFailed   = agentResults.attacker?.status    === 'fail';
  const factFailed       = agentResults.factchecker?.status === 'fail';
  if (hasCritical || confirmedExploit)         return 'block';
  if (hasHigh || attackerFailed || factFailed) return 'request-changes';
  return 'approve';
}

function buildSummary(verdict, score, findings, agentResults, codeContext, challengeResponses) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  findings.forEach(f => { if (counts[f.severity] !== undefined) counts[f.severity]++; });

  const confirmed = (agentResults.attacker?.findings || []).filter(f => f.exploitProof?.confirmed).length;
  const verdictLine = {
    block:              'BLOCK — do not merge.',
    'request-changes':  'REQUEST CHANGES — issues must be addressed before merge.',
    approve:            'APPROVE — no blocking issues found.',
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

  if (codeContext?.intent) {
    parts.push(`Code intent: ${codeContext.intent.slice(0, 120)}${codeContext.intent.length > 120 ? '…' : ''}`);
  }

  const statusLine = Object.entries(agentResults)
    .map(([n, r]) => `${n}:${r?.status ?? 'unknown'}`)
    .join(' | ');
  parts.push(`Agents — ${statusLine}.`);

  const acknowledged = (challengeResponses || []).filter(
    c => c.response?.challengeResponse?.assessment !== 'disputed'
  ).length;
  if (challengeResponses?.length) {
    parts.push(
      `Reasoner responded to ${challengeResponses.length} critical finding(s); ${acknowledged} acknowledged.`
    );
  }

  return parts.join(' ');
}

// ─── Public helpers ───────────────────────────────────────────────────────────

function buildEnrichedPayload(payload, reasonerResult) {
  const codeContext = reasonerResult?.codeContext ?? null;
  return {
    ...payload,
    codeContext,
    builderContext: codeContext
      ? `Code intent: ${codeContext.intent || 'unknown'}. ` +
        `Entry points: ${(codeContext.entryPoints || []).join(', ') || 'none'}. ` +
        `Potential risks: ${(codeContext.potentialRisks || []).join('; ') || 'none'}.`
      : null,
  };
}

/** Run the pre-processing pipeline (Parser → Reasoner). */
async function runBuilder(payload) {
  return runPreprocessingPipeline(payload);
}

async function runAgent(agentName, payload) {
  const moduleRef = AGENT_MODULES[agentName];
  if (!moduleRef) throw new Error(`Unsupported agent: ${agentName}`);
  const { result } = await safeRun(moduleRef, agentName, payload);
  return result;
}

function withDefaults(partialResults = {}) {
  const base = {};
  AGENT_ORDER.forEach(name => {
    base[name] = partialResults[name] || skippedResult(name);
  });
  return base;
}

async function finalize(collectedResults, payload) {
  const agentResults  = withDefaults(collectedResults);
  const codeContext   = collectedResults.reasoner?.codeContext ?? null;

  const allFindings = [
    ...normaliseAll(agentResults.factchecker.findings, 'factchecker'),
    ...normaliseAll(agentResults.attacker.findings,    'attacker'),
    ...normaliseAll(agentResults.skeptic.findings,     'skeptic'),
  ];

  const prioritizedFindings  = sortFindings(deduplicate(allFindings));
  const challengeResponses   = await runChallengeLoop(codeContext, prioritizedFindings);

  challengeResponses.forEach(({ finding, response }) => {
    const match = prioritizedFindings.find(
      f => f.source === finding.source && f.line === finding.line && f.description === finding.description
    );
    if (match) match.challengeResponse = response.challengeResponse ?? null;
  });

  const score   = calculateScore(prioritizedFindings, agentResults.attacker);
  const verdict = determineVerdict(prioritizedFindings, agentResults);
  const summary = buildSummary(verdict, score, prioritizedFindings, agentResults, codeContext, challengeResponses);

  return {
    agent:    'orchestrator',
    verdict,
    score,
    agentResults,
    agentStatuses: Object.fromEntries(
      Object.entries(agentResults).map(([k, v]) => [k, v?.status ?? 'unknown'])
    ),
    prioritizedFindings,
    challengeResponses,
    summary,
    sessionId: payload?.sessionId || null,
  };
}

async function run(payload) {
  const reasonerResult  = await runPreprocessingPipeline(payload);
  const enrichedPayload = buildEnrichedPayload(payload, reasonerResult);

  const [factResult, attackResult, skepticResult] = await Promise.all([
    runAgent('factchecker', enrichedPayload),
    runAgent('attacker',    enrichedPayload),
    runAgent('skeptic',     enrichedPayload),
  ]);

  return finalize({
    reasoner:    reasonerResult,
    factchecker: factResult,
    attacker:    attackResult,
    skeptic:     skepticResult,
  }, payload);
}

module.exports = { run, runBuilder, runAgent, buildEnrichedPayload, finalize, skippedResult };
