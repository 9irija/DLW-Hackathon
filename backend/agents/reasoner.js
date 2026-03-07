/**
 * reasoner — formerly the "Builder" agent, now focused on understanding
 * parsed code and producing CodeContext for downstream reviewers.
 *
 * Role: Parser → [Reasoner] → Fact Checker → Attacker → Skeptic
 *
 * Responsibilities:
 *   1. Accept either raw code or a parsed structure from the Parser agent.
 *   2. Analyse intent, entry points, dependencies, data flows, and risks.
 *   3. Return a CodeContext object that the Fact Checker and others can use.
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
const { trimCodeForPrompt } = require('../core/parser');

// model choices mirror the old builder config
const REASONER_MODEL = process.env.REASONER_MODEL || process.env.CODEX_MODEL || 'gpt-5.1-codex-mini';

const REASONER_SYSTEM_PROMPT = `You are the Reasoner Agent in a multi-agent AI code review system embedded in VS Code.

Your job is to be the definitive context provider for every other agent in the pipeline.
When given code (or a set of parsed segments produced by a preprocessing step) you must
analyse it deeply and return a structured JSON object called CodeContext.  You are held
accountable: if downstream agents (Fact Checker, Attacker) surface contradictions or
violations in your output, you will be asked to respond.

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

When parsing instructions you may leverage the provided "parsed" information to
bias your thinking (e.g. the results of an earlier Parser run).  However the output
must still describe the entire submission, not just a single segment.

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

function repairTruncatedJson(raw) {
  raw = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(raw); } catch (_) {}
  const first = raw.indexOf('{');
  const last  = raw.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(raw.slice(first, last + 1)); } catch (_) {}
  }
  let snippet = first !== -1 ? raw.slice(first) : raw;
  const quoteCount = (snippet.match(/"(?!\\)/g) || []).length;
  if (quoteCount % 2 !== 0) snippet += '"';
  const stack = [];
  for (const ch of snippet) {
    if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if ((ch === '}' || ch === ']') && stack.length) stack.pop();
  }
  snippet += stack.reverse().join('');
  try { return JSON.parse(snippet); } catch (_) {}
  return null;
}

async function analyseCode(submission) {
  // submission: { code, filePath?, lineStart?, lineEnd?, parsed? }
  const { code, filePath = 'unknown', lineStart = 0, lineEnd = 0, parsed } = submission;
  const submissionId = crypto.randomUUID();

  let promptCode = trimCodeForPrompt(code, 12000);
  if (promptCode !== code) {
    console.warn(
      `[reasoner] code length ${code.length} exceeds threshold; trimming for prompt`
    );
  }

  const fence = '```';
  const hyphen = '-';
  const userMessageLines = [];

  if (parsed && Array.isArray(parsed) && parsed.length) {
    userMessageLines.push('PARSED SEGMENTS:');
    parsed.forEach((seg, idx) => {
      userMessageLines.push(`  [${idx}] lines ${seg.lineStart}-${seg.lineEnd}`);
    });
    userMessageLines.push('');
  }

  userMessageLines.push('SUBMISSION ID: ' + submissionId);
  userMessageLines.push('FILE: ' + filePath);
  userMessageLines.push('LINES: ' + lineStart + hyphen + lineEnd);
  userMessageLines.push('');
  userMessageLines.push(fence);
  userMessageLines.push(promptCode);
  userMessageLines.push(fence);
  userMessageLines.push('');
  userMessageLines.push('(Note: sections marked "<CODE OMITTED: …>" were removed from the');
  userMessageLines.push('prompt for brevity; assume the omitted portions continue in the same');
  userMessageLines.push('style.)');
  userMessageLines.push('');
  userMessageLines.push('Analyse this code and return the CodeContext JSON object.');
  userMessageLines.push('Populate submissionId with: ' + submissionId);
  userMessageLines.push('Populate lineRange with: { "file": "' + filePath + '", "start": ' + lineStart + ', "end": ' + lineEnd + ' }');
  userMessageLines.push('');
  userMessageLines.push('IMPORTANT: Be concise — keep all string values short (intent ≤ 150 chars, each array');
  userMessageLines.push('entry ≤ 80 chars). Omit the "rawCode" field entirely; it will be injected later.');
  userMessageLines.push('Output ONLY raw JSON, no markdown fences, no explanation.');

  const userMessage = userMessageLines.join('\n');

  let raw;
  let codeContext;
  const MAX_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    raw = await complete({
      model: REASONER_MODEL,
      system: REASONER_SYSTEM_PROMPT,
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
      throw new Error(`Reasoner Agent: Failed to parse CodeContext JSON after ${MAX_ATTEMPTS} attempts.\nRaw response:\n${raw}`);
    }
  }

  codeContext.submissionId = submissionId;
  codeContext.rawCode = code;
  codeContext.lineRange = { file: filePath, start: lineStart, end: lineEnd };

  return codeContext;
}

async function respondToChallenge(codeContext, challenge) {
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
    model: REASONER_MODEL,
    system: REASONER_SYSTEM_PROMPT,
    user: challengeMessage,
    temperature: 0.1,
    max_tokens: 2048,
    jsonMode: true,
  });

  const challengeResponse = repairTruncatedJson(raw);
  if (!challengeResponse) {
    throw new Error(`Reasoner Agent: Failed to parse challengeResponse JSON.\nRaw response:\n${raw}`);
  }
  return challengeResponse;
}

function loadFileRange(filePath, lineStart, lineEnd) {
  const absolutePath = path.resolve(filePath);
  const fileContent = fs.readFileSync(absolutePath, 'utf8');
  const lines = fileContent.split('\n');
  const slicedLines = lines.slice(lineStart - 1, lineEnd);
  const code = slicedLines.join('\n');
  return { code, filePath, lineStart, lineEnd };
}

async function run(payload) {
  const { code, filePath, language, parsed } = payload;
  const lineStart = payload.lineStart ?? 0;
  const lineEnd = payload.lineEnd ?? 0;

  let codeContext;
  try {
    codeContext = await analyseCode({
      code,
      filePath: filePath || 'unknown',
      lineStart,
      lineEnd,
      parsed,
    });
  } catch (err) {
    console.error('[reasoner] analyseCode error, retrying with trimmed code:', err.message);
    try {
      const trimmedCode = trimCodeForPrompt(code, 4000);
      codeContext = await analyseCode({
        code: trimmedCode,
        filePath: filePath || 'unknown',
        lineStart,
        lineEnd,
        parsed,
      });
      codeContext.intent = (codeContext.intent || '') +
        ' (partial: original code was too large)';
    } catch (err2) {
      return {
        agent: 'reasoner',
        status: 'fail',
        findings: [{
          line: undefined,
          category: 'reasoner-error',
          description: err2.message,
          severity: 'high',
          suggestion: 'Check code and retry.',
        }],
        summary: `Reasoner analysis failed: ${err2.message}`,
        codeContext: null,
      };
    }
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
    ? `Reasoner: ${codeContext.intent.slice(0, 120)}${codeContext.intent.length > 120 ? '…' : ''}`
    : 'Reasoner analysis complete; code context ready for downstream agents.';

  return {
    agent: 'reasoner',
    status,
    findings,
    summary,
    codeContext,
  };
}

module.exports = { run, analyseCode, respondToChallenge, loadFileRange };