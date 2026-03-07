/**
 * attacker — Adversarial Security Agent
 *
 * 3-step exploit-proof pipeline:
 *
 *   Step 1 — Static analysis (gpt-4o)
 *     Scans the code for security vulnerabilities. Produces structured findings
 *     with CWE IDs, severity, attack vector, impact, and remediation advice.
 *
 *   Step 2 — PoC generation (gpt-4o-mini, high/critical only)
 *     For every high or critical finding, asks the model to generate a
 *     self-contained Node.js script that mocks the vulnerable logic inline
 *     and attempts to trigger the flaw with a crafted input.
 *
 *   Step 3 — Shadow execution (shadow/runner)
 *     Runs each PoC in an isolated child_process (5 s timeout).
 *     If the script exits 0 and prints "CONFIRMED", exploitProof.confirmed = true.
 *
 * Output shape:
 * {
 *   agent: "attacker",
 *   status: "pass" | "warn" | "fail",
 *   findings: [{
 *     line, type, description, severity, cwe, attackVector, impact,
 *     suggestion, exploitProof: { confirmed, output }
 *   }],
 *   summary: string
 * }
 */

require('dotenv').config();
const { complete }   = require('../core/llm');
const { runSnippet } = require('../shadow/runner');
const { trimCodeForPrompt } = require('../core/parser');

// Default Codex (Responses API). Override with ATTACKER_MODEL / ATTACKER_POC_MODEL in .env for Chat Completions.
const ATTACKER_MODEL     = process.env.ATTACKER_MODEL     || process.env.CODEX_MODEL || 'gpt-5.1-codex-mini';
const ATTACKER_POC_MODEL = process.env.ATTACKER_POC_MODEL || process.env.CODEX_MODEL || 'gpt-5.1-codex-mini';

// ─── Prompts ─────────────────────────────────────────────────────────────────

const STATIC_SYSTEM = `You are an adversarial security agent performing a thorough static security review.

For each vulnerability you find, output one finding with:
- line: approximate line number (number) where the vulnerability is present
- type: short vulnerability name (e.g. "SQL Injection", "Path Traversal", "Command Injection")
- description: what is vulnerable and how an attacker could exploit it
- severity: "critical" | "high" | "medium" | "low"
- cwe: CWE number only (e.g. 89) — omit if not applicable
- attackVector: "network" | "local" | "adjacent" | "physical"
- impact: one sentence on what damage a successful exploit causes
- suggestion: one sentence on how to fix it

Focus on OWASP Top 10: injection, broken auth, sensitive data exposure, XXE, broken access control,
security misconfiguration, XSS, insecure deserialization, known-vulnerable dependencies, insufficient logging.

Respond with valid JSON only — no markdown, no extra text:
{"findings": [...], "summary": "string"}`;

const POC_SYSTEM = `You are a security researcher writing proof-of-concept (PoC) exploit scripts.

Given a vulnerability and the original code, write a self-contained Node.js script with NO external npm packages.
Rules:
1. Copy or mock the vulnerable logic inline — do not require the original file.
2. Craft a malicious input that triggers the flaw.
3. If you can demonstrate the vulnerability: print "CONFIRMED" to stdout and exit with code 0.
4. If you cannot demonstrate it in isolation: print "NOT_CONFIRMED" and exit with code 1.

Output ONLY the Node.js code — no markdown fences, no explanation.`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normaliseFindings(raw) {
  return (raw || []).map(f => ({
    line:         typeof f.line === 'number' ? f.line : undefined,
    type:         String(f.type        ?? 'vulnerability'),
    description:  String(f.description ?? ''),
    severity:     ['critical','high','medium','low'].includes(String(f.severity).toLowerCase())
                    ? String(f.severity).toLowerCase() : 'medium',
    cwe:          f.cwe != null ? String(f.cwe) : undefined,
    attackVector: f.attackVector ?? undefined,
    impact:       String(f.impact      ?? ''),
    suggestion:   String(f.suggestion  ?? ''),
    exploitProof: { confirmed: false, output: null },
  }));
}

// minimal repair logic copied from builder to handle truncated JSON responses
function repairTruncatedJson(raw) {
  raw = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(raw); } catch (_) {}
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(raw.slice(first, last + 1)); } catch (_) {}
  }
  let snippet = first !== -1 ? raw.slice(first) : raw;
  const quoteCount = (snippet.match(/(?<!\\)"/g) || []).length;
  if (quoteCount % 2 !== 0) snippet += '"';
  const stack = [];
  for (const ch of snippet) {
    if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if ((ch === '}' || ch === ']') && stack.length) stack.pop();
  }
  snippet += stack.reverse().join('');
  try { return JSON.parse(snippet); } catch (_) {}
  throw new Error('Unable to repair JSON');
}

// ─── Step 1: Static analysis ──────────────────────────────────────────────────

async function staticAnalysis(code, filePath, language, builderContext, allowChunk = true) {
  // internal helper that actually calls the model and repairs JSON
  const perform = async (src) => {
    const promptCode = trimCodeForPrompt(src, 12000);
    if (promptCode !== src) {
      console.warn(
        `[attacker] trimming code from ${src.length} to ${promptCode.length} chars for static analysis`
      );
    }
    const userContent = [
      builderContext ? `Context from builder: ${builderContext}\n\n` : '',
      `File: ${filePath}\nLanguage: ${language}\n\n`,
      `Code:\n\`\`\`\n${promptCode}\n\`\`\`\n\n`,
      'Find all security vulnerabilities. Output JSON only.',
    ].join('');

    const raw = (await complete({
      model: ATTACKER_MODEL,
      system: STATIC_SYSTEM,
      user: userContent,
      temperature: 0.1,
      max_tokens: 2048,
      jsonMode: false, // we'll handle JSON ourselves so we can repair if needed
    })) || '{}';

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      parsed = repairTruncatedJson(raw);
    }

    return {
      findings: normaliseFindings(parsed.findings),
      summary:  typeof parsed.summary === 'string' ? parsed.summary : 'Attacker: analysis complete.',
    };
  };

  try {
    return await perform(code);
  } catch (err) {
    console.error('[attacker] static analysis error:', err.message);
    if (allowChunk && code.length > 4000) {
      console.warn('[attacker] falling back to chunked static analysis');
      const mid = Math.floor(code.length / 2);
      const splitPos = code.lastIndexOf('\n', mid) || mid;
      const left = code.slice(0, splitPos);
      const right = code.slice(splitPos);
      let leftRes = { findings: [], summary: '' };
      let rightRes = { findings: [], summary: '' };
      try {
        leftRes = await staticAnalysis(left, filePath, language, builderContext, false);
      } catch (e) {
        console.error('[attacker] chunk-left failure:', e.message);
      }
      try {
        rightRes = await staticAnalysis(right, filePath, language, builderContext, false);
      } catch (e) {
        console.error('[attacker] chunk-right failure:', e.message);
      }
      const leftLines = left.split('\n').length;
      rightRes.findings.forEach(f => {
        if (typeof f.line === 'number') f.line += leftLines;
      });
      return {
        findings: leftRes.findings.concat(rightRes.findings),
        summary: `${leftRes.summary}${leftRes.summary && rightRes.summary ? ' | ' : ''}${rightRes.summary}`,
      };
    }
    throw err;
  }
}

// ─── Step 2: PoC generation ───────────────────────────────────────────────────

async function generatePoC(finding, code) {
  const userContent = [
    `Vulnerability: ${finding.type}`,
    `Description: ${finding.description}`,
    `CWE: ${finding.cwe ? `CWE-${finding.cwe}` : 'N/A'}`,
    '',
    'Original code (for context — mock the logic inline, do NOT require this file):',
    '```',
    code.slice(0, 3000),
    '```',
    '',
    'Write a self-contained Node.js PoC that demonstrates this vulnerability.',
  ].join('\n');

  const raw = (await complete({
    model: ATTACKER_POC_MODEL,
    system: POC_SYSTEM,
    user: userContent,
    temperature: 0.2,
    max_tokens: 2048,
  })).trim();
  return raw
    .replace(/^```(?:js|javascript)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

// ─── Step 3: Shadow execution ────────────────────────────────────────────────

async function runPoC(poc) {
  if (!poc) return { confirmed: false, output: null };
  const result = await runSnippet(poc, 'javascript');
  return {
    confirmed: result.executed && result.exitCode === 0 && result.stdout.includes('CONFIRMED'),
    output:    (result.stdout || result.stderr || '').slice(0, 300),
  };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * @param {object} payload
 * @param {string}   payload.code
 * @param {string}   payload.filePath
 * @param {string}   payload.language
 * @param {string}   [payload.builderContext]  — enriched context from orchestrator Phase 1
 * @returns {Promise<object>}
 */
async function run(payload) {
  const { code, filePath, language, builderContext } = payload;

  // ── Step 1: Static vulnerability scan ─────────────────────────────────────
  let findings, summary;
  try {
    ({ findings, summary } = await staticAnalysis(code, filePath, language, builderContext));
  } catch (err) {
    console.error('[attacker] static analysis error:', err.message);
    // retry with trimmed code to salvage something
    try {
      const trimmed = trimCodeForPrompt(code, 4000);
      console.warn('[attacker] retrying static analysis with trimmed code');
      ({ findings, summary } = await staticAnalysis(trimmed, filePath, language, builderContext));
      summary += ' (partial: original code trimmed due to length)';
    } catch (err2) {
      return {
        agent:    'attacker',
        status:   'warn',
        findings: [],
        summary:  `Attacker static analysis failed: ${err2.message}`,
      };
    }
  }

  // ── Steps 2 + 3: PoC generation + execution (high/critical only) ──────────
  const exploitTargets = findings.filter(f => f.severity === 'critical' || f.severity === 'high');

  await Promise.all(
    exploitTargets.map(async (finding) => {
      try {
        const poc = await generatePoC(finding, code);
        finding.exploitProof = await runPoC(poc);
      } catch {
        // PoC failure is non-fatal; exploitProof stays { confirmed: false, output: null }
      }
    })
  );

  // ── Status ────────────────────────────────────────────────────────────────
  const hasCritical = findings.some(f => f.severity === 'critical');
  const hasHigh     = findings.some(f => f.severity === 'high');
  const status = hasCritical || hasHigh ? 'fail'
               : findings.length > 0    ? 'warn'
               : 'pass';

  return { agent: 'attacker', status, findings, summary };
}

module.exports = { run };
