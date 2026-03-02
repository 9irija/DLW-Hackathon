/**
 * builder — Codex Integration & Code Context Provider
 *
 * Role: Orchestrator → [Builder] → Fact Checker → Attacker → Skeptic
 *
 * Responsibilities:
 *   1. Accept code submission and use OpenAI to analyse intent, structure, dependencies
 *   2. Return CodeContext for downstream agents
 *   3. respondToChallenge when Fact Checker / Attacker flag issues tracing to Builder
 *
 * Output (run): { agent, status, findings, summary, codeContext }
 * CodeContext: { submissionId, language, intent, entryPoints, dependencies, externalCalls,
 *               sideEffects, dataFlows, potentialRisks, rawCode, lineRange }
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { complete } = require('../core/llm');

// Default Codex (Responses API). Override with BUILDER_MODEL in .env to use Chat Completions (e.g. gpt-4o).
const BUILDER_MODEL = process.env.CODEX_MODEL || process.env.BUILDER_MODEL || 'gpt-5-codex';

const BUILDER_SYSTEM_PROMPT = `You are the Builder Agent in a multi-agent AI code review system embedded in VS Code.

Your job is to be the definitive context provider for every other agent in the pipeline.
When given a code snippet you must analyse it deeply and return a structured JSON object
called CodeContext. You are held accountable: if downstream agents (Fact Checker, Attacker)
surface contradictions or violations in your output, you will be asked to respond.

─── YOUR ANALYSIS MUST COVER ────────────────────────────────────────────────

1. INTENT        — What is this code trying to do? One clear paragraph.
2. LANGUAGE      — Detected language and version if determinable.
3. ENTRY POINTS  — All exported, public, or callable functions/classes/routes.
4. DEPENDENCIES  — Every import, require, or package reference.
5. EXTERNAL CALLS — Any HTTP requests, database queries, file system access,
                    or third-party service calls. Include method and target if visible.
6. SIDE EFFECTS  — State mutations, writes, deletions, or anything that changes
                   external state beyond the function's return value.
7. DATA FLOWS    — How data moves through the code: { from, to, dataType }.
                   Trace user input through to outputs/storage.
8. POTENTIAL RISKS — Your own preliminary flags: unvalidated inputs, hardcoded
                     secrets, unsafe operations, missing error handling, etc.

─── OUTPUT FORMAT ───────────────────────────────────────────────────────────

Always respond with a single valid JSON object matching this schema exactly.
Do not include markdown fences or explanation outside the JSON.
Be concise: keep intent under 150 chars, each array entry under 80 chars.
OMIT the "rawCode" field entirely — it will be injected automatically.

{
  "submissionId":   "<uuid>",
  "language":       "<string>",
  "intent":         "<string>",
  "entryPoints":    ["<string>"],
  "dependencies":   ["<string>"],
  "externalCalls":  ["<string>"],
  "sideEffects":    ["<string>"],
  "dataFlows":      [{ "from": "<string>", "to": "<string>", "dataType": "<string>" }],
  "potentialRisks": ["<string>"],
  "lineRange":      { "file": "<string>", "start": <number>, "end": <number> }
}

─── WHEN CHALLENGED ─────────────────────────────────────────────────────────

If a downstream agent flags a contradiction, hallucination, or vulnerability that
traces back to your analysis, you will receive a CHALLENGE message. Respond with:

{
  "challengeResponse": {
    "finding":     "<what was flagged>",
    "assessment":  "acknowledged | disputed | requires_fix",
    "explanation": "<your reasoning>",
    "proposedFix": "<corrected code or null>"
  }
}
`;

/**
 * Attempt to parse potentially truncated/malformed JSON from the LLM.
 * Tries progressively more aggressive repair strategies before giving up.
 * @param {string} raw
 * @returns {object|null}
 */
function repairTruncatedJson(raw) {
  // 1. Strip markdown fences if present
  raw = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();

  // 2. Straightforward parse
  try { return JSON.parse(raw); } catch (_) {}

  // 3. Extract outermost { ... }
  const first = raw.indexOf('{');
  const last  = raw.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(raw.slice(first, last + 1)); } catch (_) {}
  }

  // 4. Response was truncated mid-JSON — close all open structures
  let snippet = first !== -1 ? raw.slice(first) : raw;

  // Close any open string (odd number of unescaped quotes)
  const quoteCount = (snippet.match(/(?<!\\)"/g) || []).length;
  if (quoteCount % 2 !== 0) snippet += '"';

  // Close open arrays/objects by walking the bracket stack
  const stack = [];
  for (const ch of snippet) {
    if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if ((ch === '}' || ch === ']') && stack.length) stack.pop();
  }
  snippet += stack.reverse().join('');

  try { return JSON.parse(snippet); } catch (_) {}

  return null; // all strategies exhausted
}

/**
 * Analyse code and return CodeContext.
 * @param {object} submission - { code, filePath?, lineStart?, lineEnd? }
 * @returns {Promise<object>} CodeContext
 */
async function analyseCode(submission) {
  const { code, filePath = 'unknown', lineStart = 0, lineEnd = 0 } = submission;
  const submissionId = crypto.randomUUID();

  const userMessage = `
SUBMISSION ID: ${submissionId}
FILE: ${filePath}
LINES: ${lineStart}–${lineEnd}

\`\`\`
${code}
\`\`\`

Analyse this code and return the CodeContext JSON object.
Populate submissionId with: ${submissionId}
Populate lineRange with: { "file": "${filePath}", "start": ${lineStart}, "end": ${lineEnd} }

IMPORTANT: Be concise — keep all string values short (intent ≤ 150 chars, each array
entry ≤ 80 chars). Omit the "rawCode" field entirely; it will be injected later.
Output ONLY raw JSON, no markdown fences, no explanation.
`;

  let raw;
  let codeContext;
  const MAX_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    raw = await complete({
      model: BUILDER_MODEL,
      system: BUILDER_SYSTEM_PROMPT,
      user: attempt === 1
        ? userMessage
        : userMessage + '\n\nNOTE: Your previous response was truncated or invalid JSON. Reply with compact JSON only — no prose, no markdown.',
      temperature: 0.1,
      max_tokens: 8192,
      jsonMode: true,
    });

    codeContext = repairTruncatedJson(raw);
    if (codeContext) break;

    if (attempt === MAX_ATTEMPTS) {
      throw new Error(`Builder Agent: Failed to parse CodeContext JSON after ${MAX_ATTEMPTS} attempts.\nRaw response:\n${raw}`);
    }
    // otherwise loop to retry
  }

  // Always inject these server-side — never trust the model to reproduce them correctly
  codeContext.submissionId = submissionId;
  codeContext.rawCode = code;
  codeContext.lineRange = { file: filePath, start: lineStart, end: lineEnd };

  return codeContext;
}

/**
 * Respond when Fact Checker or Attacker flags an issue that implicates Builder's analysis.
 * @param {object} codeContext - from analyseCode()
 * @param {object} challenge - { agentName, finding, severity }
 * @returns {Promise<object>} challengeResponse
 */
async function respondToChallenge(codeContext, challenge) {
  // Omit rawCode from the context sent back to the model to avoid token bloat
  const { rawCode: _omit, ...contextForPrompt } = codeContext;

  const challengeMessage = `
You previously produced the following CodeContext for submission ${codeContext.submissionId}:

${JSON.stringify(contextForPrompt, null, 2)}

The ${challenge.agentName} has now flagged the following issue:

FINDING   : ${challenge.finding}
SEVERITY  : ${challenge.severity || 'unspecified'}

This finding may trace back to your original analysis.
Respond with the challengeResponse JSON object as specified in your instructions.
Output ONLY raw JSON, no markdown fences, no explanation.
`;

  const raw = await complete({
    model: BUILDER_MODEL,
    system: BUILDER_SYSTEM_PROMPT,
    user: challengeMessage,
    temperature: 0.1,
    max_tokens: 2048,
    jsonMode: true,
  });

  const challengeResponse = repairTruncatedJson(raw);
  if (!challengeResponse) {
    throw new Error(`Builder Agent: Failed to parse challengeResponse JSON.\nRaw response:\n${raw}`);
  }
  return challengeResponse;
}

/**
 * Load a line range from a file (for Orchestrator to use before calling analyseCode).
 * @param {string} filePath - absolute or workspace-relative path
 * @param {number} lineStart - 1-indexed
 * @param {number} lineEnd - 1-indexed inclusive
 * @returns {{ code: string, filePath: string, lineStart: number, lineEnd: number }}
 */
function loadFileRange(filePath, lineStart, lineEnd) {
  const absolutePath = path.resolve(filePath);
  const fileContent = fs.readFileSync(absolutePath, 'utf8');
  const lines = fileContent.split('\n');
  const slicedLines = lines.slice(lineStart - 1, lineEnd);
  const code = slicedLines.join('\n');
  return { code, filePath, lineStart, lineEnd };
}

/**
 * Agent entry: run(payload) for pipeline. Analyses code, returns agent result + codeContext.
 * @param {object} payload - { code, filePath, language?, lineStart?, lineEnd?, ... }
 * @returns {Promise<object>} { agent, status, findings, summary, codeContext }
 */
async function run(payload) {
  const { code, filePath, language } = payload;
  const lineStart = payload.lineStart ?? 0;
  const lineEnd = payload.lineEnd ?? 0;

  let codeContext;
  try {
    codeContext = await analyseCode({
      code,
      filePath: filePath || 'unknown',
      lineStart,
      lineEnd,
    });
  } catch (err) {
    return {
      agent: 'builder',
      status: 'fail',
      findings: [{
        line: undefined,
        category: 'builder-error',
        description: err.message,
        severity: 'high',
        suggestion: 'Check code and retry.',
      }],
      summary: `Builder analysis failed: ${err.message}`,
      codeContext: null,
    };
  }

  const potentialRisks = codeContext.potentialRisks || [];
  const findings = potentialRisks.map((risk) => ({
    line: codeContext.lineRange?.start,
    category: 'potential-risk',
    description: typeof risk === 'string' ? risk : String(risk),
    severity: 'medium',
    suggestion: 'Review and address before merge.',
  }));

  const hasHigh = findings.some((f) => f.severity === 'high');
  const hasMedium = findings.length > 0;
  const status = hasHigh ? 'fail' : hasMedium ? 'warn' : 'pass';
  const summary = codeContext.intent
    ? `Builder: ${codeContext.intent.slice(0, 120)}${codeContext.intent.length > 120 ? '…' : ''}`
    : 'Builder analysis complete; code context ready for downstream agents.';

  return {
    agent: 'builder',
    status,
    findings,
    summary,
    codeContext,
  };
}

module.exports = { run, analyseCode, respondToChallenge, loadFileRange };