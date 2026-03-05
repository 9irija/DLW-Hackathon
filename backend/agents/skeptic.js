/**
 * Skeptic — Shadow Execution & Evidence Engine.
 * Runs code/tests in an isolated environment and reports real failures with evidence
 * for: failure timeline, endpoint heatmap, latency distribution, user journey failures,
 * and a system flow diagram.
 * No LLM/Codex: uses only shadow/runner, testRunner, flowParser; no model env config.
 *
 * Output shape:
 * {
 *   agent: "skeptic",
 *   status: "pass" | "warn" | "fail",
 *   confidence: number,
 *   findings: [{ line, category, description, severity, confidence, suggestion }],
 *   summary: string,
 *   evidence?: { failureTimeline, endpointHeatmap, latencyDistribution, userJourneyFailures },
 *   flow?: { nodes, edges }
 * }
 */

const { runSnippet } = require('../shadow/runner');
const { runTestSuite } = require('../shadow/testRunner');
const { buildFlowFromCode } = require('../shadow/flowParser');

/**
 * @param {object} payload
 * @param {string}   payload.code
 * @param {string}   payload.filePath
 * @param {string}   payload.language
 * @param {string}   [payload.diff]
 * @param {string}   [payload.workspaceRoot] - if set, run full test suite
 * @param {object[]} [payload.context]
 * @returns {Promise<object>}
 */
async function run(payload) {
  const { code, filePath, language, workspaceRoot } = payload;
  const findings = [];
  let evidence = null;
  let flow = null;

  // 1. Build system flow from code (imports/requires)
  flow = buildFlowFromCode(code, filePath);

  // 2. Run tests in shadow environment if workspace root provided; else run snippet
  if (workspaceRoot) {
    const suiteResult = await runTestSuite(workspaceRoot);
    evidence = buildEvidenceFromTestSuite(suiteResult);
    if (suiteResult.ran && suiteResult.tests.length > 0) {
      suiteResult.tests.filter((t) => t.outcome === 'fail').forEach((t) => {
        findings.push({
          line: undefined,
          category: 'test-failure',
          description: t.name + (t.error ? `: ${t.error.slice(0, 200)}` : ''),
          severity: 'high',
          confidence: 90,
          suggestion: 'Fix the failing test or update the expectation.',
        });
      });
      // User journey proxy: treat describe blocks or integration-style test names as "journeys"
      evidence.userJourneyFailures = suiteResult.tests
        .filter((t) => t.outcome === 'fail' && (t.name.includes('integration') || t.name.includes('flow') || t.name.includes('user') || t.name.includes('e2e')))
        .map((t) => ({ name: t.name, failed: true, error: t.error }));
    }
  } else {
    const runResult = await runSnippet(code, language);
    evidence = buildEvidenceFromSnippet(runResult, filePath);
    if (runResult.executed && (runResult.exitCode !== 0 || runResult.stderr)) {
      findings.push({
        line: undefined,
        category: 'runtime',
        description: runResult.stderr || `Exit code ${runResult.exitCode}`,
        severity: runResult.timedOut ? 'high' : 'medium',
        confidence: 85,
        suggestion: 'Fix runtime errors or timeouts before deploying.',
      });
    }
  }

  const hasFail = findings.some((f) => f.severity === 'high' || f.severity === 'critical');
  const hasWarn = findings.some((f) => f.severity === 'medium');
  const status = hasFail ? 'fail' : hasWarn ? 'warn' : 'pass';
  const confidence = status === 'pass' ? 90 : status === 'warn' ? 70 : 50;

  const summary =
    evidence && evidence.failureTimeline && evidence.failureTimeline.length > 0
      ? `Shadow execution: ${evidence.failureTimeline.filter((p) => p.failed).length} failure(s) observed.`
      : flow && flow.nodes.length > 0
        ? 'No test failures; flow graph available for impact analysis.'
        : 'Skeptic: shadow execution completed; no failures detected.';

  const recommendation = buildRecommendation(findings, evidence);

  return {
    agent: 'skeptic',
    status,
    confidence,
    findings,
    summary,
    recommendation,
    evidence: evidence || undefined,
    flow: flow && (flow.nodes.length > 1 || flow.edges.length > 0) ? flow : undefined,
  };
}

/**
 * Synthesise an actionable recommendation from findings and execution evidence.
 *
 * Returns { action: 'approve'|'review'|'hold', label: string, reasons: string[] }
 *
 *   hold    — at least one high/critical finding (test failure, runtime error, timeout).
 *             Blocks deployment: developer must fix before proceeding.
 *   review  — medium findings or a measurable latency regression (p99 > 50% increase).
 *             Caution advised; developer should consciously decide.
 *   approve — all checks passed; safe to proceed.
 */
function buildRecommendation(findings, evidence) {
  const reasons = [];

  // Blocking: any high or critical finding
  const blocking = findings.filter((f) => f.severity === 'high' || f.severity === 'critical');
  if (blocking.length > 0) {
    blocking.forEach((f) => reasons.push(f.description.slice(0, 140)));
    return { action: 'hold', label: 'Hold — Fix failures before deploying', reasons };
  }

  // Latency regression: p99 increased > 50% compared to baseline
  let hasLatencyRegression = false;
  const dist = evidence?.latencyDistribution;
  if (dist && Array.isArray(dist.before) && dist.before.length > 0 &&
      Array.isArray(dist.after) && dist.after.length > 0) {
    const pct = (arr, q) => {
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.floor((s.length - 1) * q)];
    };
    const p99Before = pct(dist.before, 0.99);
    const p99After  = pct(dist.after,  0.99);
    if (p99Before > 0 && p99After > p99Before * 1.5) {
      hasLatencyRegression = true;
      const pctIncrease = Math.round((p99After / p99Before - 1) * 100);
      reasons.push(`p99 latency increased ${pctIncrease}% (${p99Before}ms → ${p99After}ms)`);
    }
  }

  // Cautionary: medium findings
  const cautionary = findings.filter((f) => f.severity === 'medium');
  cautionary.forEach((f) => reasons.push(f.description.slice(0, 140)));

  if (cautionary.length > 0 || hasLatencyRegression) {
    return { action: 'review', label: 'Review — Proceed with caution', reasons };
  }

  reasons.push('No test failures, runtime errors, or latency regressions detected.');
  return { action: 'approve', label: 'Safe to proceed', reasons };
}

/**
 * Build chart-ready evidence from test suite result.
 */
function buildEvidenceFromTestSuite(suiteResult) {
  const tests = suiteResult.tests || [];
  const failureTimeline = tests.map((t, i) => ({
    index: i + 1,
    time: i,
    label: t.name.slice(0, 40),
    passed: t.outcome === 'pass',
    failed: t.outcome === 'fail',
    durationMs: t.durationMs ?? null,
  }));

  const endpointCounts = {};
  tests.forEach((t) => {
    const key = t.name.split(' > ')[0] || t.name.slice(0, 30);
    if (!endpointCounts[key]) endpointCounts[key] = { passed: 0, failed: 0 };
    if (t.outcome === 'pass') endpointCounts[key].passed += 1;
    else endpointCounts[key].failed += 1;
  });
  const endpointHeatmap = Object.entries(endpointCounts).map(([name, v]) => ({
    endpoint: name,
    passed: v.passed,
    failed: v.failed,
    total: v.passed + v.failed,
  }));

  const durations = tests.map((t) => t.durationMs).filter((d) => d != null && d > 0);
  const latencyDistribution = {
    before: [], // no baseline in single run; use first half vs second half as proxy
    after: durations,
    unit: 'ms',
  };
  if (durations.length >= 2) {
    const mid = Math.floor(durations.length / 2);
    latencyDistribution.before = durations.slice(0, mid);
    latencyDistribution.after = durations.slice(mid);
  }

  const userJourneyFailures = (suiteResult.tests || [])
    .filter((t) => t.outcome === 'fail')
    .map((t) => ({ name: t.name, failed: true, error: t.error }));

  return {
    failureTimeline,
    endpointHeatmap,
    latencyDistribution,
    userJourneyFailures: userJourneyFailures.length ? userJourneyFailures : undefined,
  };
}

/**
 * Build chart-ready evidence from single snippet run.
 */
function buildEvidenceFromSnippet(runResult, filePath) {
  const failed = runResult.exitCode !== 0 || runResult.timedOut;
  const failureTimeline = [
    {
      index: 1,
      time: 0,
      label: filePath ? filePath.split(/[/\\]/).pop() : 'snippet',
      passed: !failed,
      failed,
      durationMs: runResult.durationMs,
    },
  ];

  const endpointHeatmap = [
    {
      endpoint: filePath ? filePath.split(/[/\\]/).pop() : 'snippet',
      passed: failed ? 0 : 1,
      failed: failed ? 1 : 0,
      total: 1,
    },
  ];

  const latencyDistribution = {
    before: [],
    after: runResult.executed ? [runResult.durationMs] : [],
    unit: 'ms',
  };

  return {
    failureTimeline,
    endpointHeatmap,
    latencyDistribution,
    userJourneyFailures: failed ? [{ name: 'Snippet execution', failed: true, error: runResult.stderr }] : undefined,
  };
}

module.exports = { run };
