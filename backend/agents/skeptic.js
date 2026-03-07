/**
 * Skeptic — Shadow Execution & Evidence Engine.
 * Runs code/tests in an isolated environment and reports real failures with evidence
 * for: failure timeline, endpoint heatmap, latency distribution, user journey failures,
 * and a system flow diagram.
 * Uses the LLM narrowly to interpret cryptic JS runtime errors into plain-English suggestions.
 *
 * Output shape:
 * {
 *   agent: "skeptic",
 *   status: "pass" | "warn" | "fail",
 *   confidence: number,
 *   findings: [{ line, category, description, severity, confidence, suggestion }],
 *   summary: string,
 *   evidence?: { failureTimeline, endpointHeatmap, latencyDistribution, userJourneyFailures },
 *   flow?: { nodes, edges },
 *   recommendation: { action, label, context, nextSteps, reasons }
 * }
 */

require('dotenv').config();
const { runSnippet } = require('../shadow/runner');
const { runTestSuite } = require('../shadow/testRunner');
const { buildFlowFromCode } = require('../shadow/flowParser');
const { complete } = require('../core/llm');

const SKEPTIC_MODEL = process.env.SKEPTIC_MODEL || process.env.CODEX_MODEL || 'gpt-5.1-codex-mini';

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
      const errorText = runResult.stderr || `Exit code ${runResult.exitCode}`;
      const suggestion = runResult.timedOut
        ? 'The snippet timed out. Check for infinite loops, blocking synchronous calls, or unbounded recursion.'
        : await interpretError(code, filePath, errorText);
      findings.push({
        line: undefined,
        category: 'runtime',
        description: errorText,
        severity: runResult.timedOut ? 'high' : 'medium',
        confidence: 85,
        suggestion,
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
 * Use an LLM to convert a raw JS runtime error into a plain-English one-sentence
 * explanation of what went wrong and how to fix it.
 * Falls back to a generic message on any error.
 *
 * @param {string} code      - The executed source code
 * @param {string} filePath  - File name (for context only)
 * @param {string} error     - Raw stderr / error output from the child process
 * @returns {Promise<string>}
 */
async function interpretError(code, filePath, error) {
  try {
    const truncatedCode = code.length > 1500 ? code.slice(0, 1500) + '\n// ... (truncated)' : code;
    const truncatedError = error.length > 600 ? error.slice(0, 600) + ' ...' : error;
    const suggestion = await complete({
      model: SKEPTIC_MODEL,
      system:
        'You are a concise code debugging assistant. Given a JavaScript snippet and its runtime error, ' +
        'reply with a single plain-English sentence explaining the root cause and what the developer ' +
        'should change to fix it. Do not use markdown, backticks, or bullet points.',
      user:
        `File: ${filePath}\n\nCode:\n${truncatedCode}\n\nRuntime error:\n${truncatedError}`,
      max_tokens: 120,
    });
    return suggestion || 'Fix the runtime error shown above before deploying.';
  } catch {
    return 'Fix the runtime error shown above before deploying.';
  }
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
    blocking.forEach((f) => {
      reasons.push(f.description.slice(0, 140));
      if (f.suggestion) reasons.push(`Fix: ${f.suggestion}`);
    });
    return {
      action: 'hold',
      label: 'Hold — Fix failures before deploying',
      context: `Shadow execution found ${blocking.length} blocking failure(s). These must be resolved before this code is safe to ship — the tests are actively failing right now.`,
      nextSteps: [
        'Look at the failing tests listed below and fix the root cause in your code.',
        'Re-run RunChecks after fixing to confirm the failures are gone.',
        'If a test expectation is wrong (not the code), update the test.',
      ],
      reasons,
    };
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
  cautionary.forEach((f) => {
    reasons.push(f.description.slice(0, 140));
    if (f.suggestion) reasons.push(`Fix: ${f.suggestion}`);
  });

  if (cautionary.length > 0 || hasLatencyRegression) {
    const what = cautionary.length > 0 && hasLatencyRegression
      ? 'runtime warnings and a latency regression'
      : hasLatencyRegression ? 'a latency regression' : `${cautionary.length} warning(s)`;
    return {
      action: 'review',
      label: 'Review — Proceed with caution',
      context: `Shadow execution completed but found ${what}. Nothing is broken right now, but these issues could cause problems under load or in edge cases.`,
      nextSteps: [
        'Read each warning below and decide if it is acceptable for your use case.',
        hasLatencyRegression ? 'Investigate the latency increase — check for added loops, sync I/O, or blocking calls.' : null,
        'If the warnings are acceptable, approve and continue. Otherwise make changes first.',
      ].filter(Boolean),
      reasons,
    };
  }

  return {
    action: 'approve',
    label: 'Safe to proceed',
    context: 'Shadow execution ran your code and found no test failures, runtime errors, or latency regressions. The code behaved as expected.',
    nextSteps: [
      'Approve this stage and continue to the final verdict.',
      'Consider adding more tests to cover edge cases if test coverage is low.',
    ],
    reasons: [],
  };
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
  // If the snippet couldn't be executed (e.g. non-JS language), return empty evidence
  // so the chart doesn't show a misleading failure.
  if (!runResult.executed) {
    return { failureTimeline: [], endpointHeatmap: [], latencyDistribution: { before: [], after: [], unit: 'ms' } };
  }
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
