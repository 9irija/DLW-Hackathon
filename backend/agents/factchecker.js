/**
 * factchecker — two-pass accuracy checker:
 *
 *   Pass 1 — Inline comments (always runs)
 *     Compares every comment, docstring, and JSDoc inside the code file
 *     against what the code actually does.
 *
 *   Pass 2 — External documentation (runs when payload.docs is provided)
 *     Compares each external document (README, API docs, specs, etc.)
 *     against the actual code implementation. Findings are tagged with
 *     docSource, docSection, and docPage so the UI can show which part
 *     of which document raised the issue.
 *
 * Output shape:
 * {
 *   agent: "factchecker",
 *   status: "pass" | "warn" | "fail",
 *   findings: [{
 *     filePath,        // which file the issue is in
 *     line,            // approximate line number (inline pass only)
 *     codeSnippet,     // the actual lines of code around the issue
 *     claim,           // what the comment/doc says
 *     reality,         // what the code actually does
 *     severity,
 *     suggestion,
 *     docSource?,      // external doc pass only: document name
 *     docSection?,     // external doc pass only: section heading in the doc
 *     docPage?,        // external doc pass only: page number if determinable
 *   }],
 *   summary: string
 * }
 */

require('dotenv').config();
const { complete } = require('../core/llm');

// Default Codex (Responses API). Override with FACTCHECKER_MODEL in .env to use Chat Completions (e.g. gpt-4o-mini).
const FACTCHECKER_MODEL = process.env.FACTCHECKER_MODEL || process.env.CODEX_MODEL || 'gpt-5-codex';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * CHANGED: New helper. Given the full source code string and a line number,
 * extracts a small window of lines (±3) around that line to use as a
 * codeSnippet in the finding. Returns an empty string if line is not provided.
 */
function extractSnippet(code, line, contextLines = 3) {
  if (!line || typeof line !== 'number') return '';
  const lines = code.split('\n');
  const start = Math.max(0, line - 1 - contextLines);
  const end   = Math.min(lines.length, line - 1 + contextLines + 1);
  return lines
    .slice(start, end)
    .map((text, i) => `${start + i + 1}: ${text}`)
    .join('\n');
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

// CHANGED: INLINE_SYSTEM now also asks the model to return a codeSnippet field
// (the verbatim comment or code line that contains the mismatch).
const INLINE_SYSTEM = `You are a fact-checker for source code. Compare every comment, docstring, JSDoc, and inline documentation in the code with what the code actually does.

For each mismatch output one finding with:
- line: approximate line number (number) where the comment/docs appear
- codeSnippet: the exact comment or docstring text that is wrong (copy it verbatim, one line max)
- claim: what the comment/documentation says
- reality: what the code actually does (brief)
- severity: "low" | "medium" | "high"
- suggestion: how to fix the comment or the code (one short sentence)

If there are no mismatches, return an empty findings array.

Respond with valid JSON only (no markdown, no extra text):
{"findings": [{"line": number, "codeSnippet": string, "claim": string, "reality": string, "severity": string, "suggestion": string}], "summary": string}
The summary should be one sentence: either "All comments match the implementation." or a brief overview of what you found.`;

// CHANGED: DOC_SYSTEM now also asks the model to return docSection and docPage
// so callers know exactly where in the external document the mismatch was found.
const DOC_SYSTEM = `You are a documentation accuracy checker. You are given an external document (README, API spec, design doc, etc.) and the actual source code it describes.

Identify every place where the document makes a claim that does not match what the code actually does.

For each discrepancy output one finding with:
- docSection: the section heading or sub-heading in the document where the claim appears (e.g. "## Installation" or "Configuration > Timeouts"). Use "unknown" if the document has no headings.
- docPage: the page number where the claim appears, as an integer, if the document is paginated (e.g. a PDF). Use null if not applicable.
- claim: what the document says (quote or paraphrase)
- reality: what the code actually does
- severity: "low" | "medium" | "high"
- suggestion: how to fix the document or the code (one short sentence)

Do not include a "line" field — external documents do not have code line numbers.
If the document accurately describes the code, return an empty findings array.

Respond with valid JSON only (no markdown, no extra text):
{"findings": [{"docSection": string, "docPage": number|null, "claim": string, "reality": string, "severity": string, "suggestion": string}], "summary": string}
The summary should be one sentence describing how well the document matches the code.`;

// ─── Pass 1: Inline comment check ────────────────────────────────────────────

// CHANGED: now accepts filePath and passes it through so findings can carry it.
// Also calls extractSnippet() to attach a codeSnippet window around each line.
// ─── JSON parsing helpers ───────────────────────────────────────────────────

/**
 * Attempt to repair and parse JSON output from an LLM response.  This
 * mirrors the strategy used by builder.repairTruncatedJson but kept local
 * to avoid cross-agent coupling.
 * @param {string} raw
 * @returns {object}
 * @throws {Error} if parsing ultimately fails
 */
function repairTruncatedJson(raw) {
  // strip markdown fences
  let txt = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/i, '').trim();

  // try straightforward parse
  try { return JSON.parse(txt); } catch (_) {}

  // extract outermost braces
  const first = txt.indexOf('{');
  const last  = txt.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(txt.slice(first, last + 1)); } catch (_) {}
  }

  // attempt to close open strings and brackets
  let snippet = first !== -1 ? txt.slice(first) : txt;

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


async function checkInlineComments(code, filePath, language, allowChunk = true) {
  // If the model repeatedly fails on large input, split the code in half and
  // analyse each part separately, then recombine the findings with adjusted
  // line numbers. This recursion stops once allowChunk is false.
  const performRequest = async (src) => {
    // trim long code to keep prompts under model limits
    const promptCode = require('../core/parser').trimCodeForPrompt(src, 12000);
    if (promptCode !== src) {
      console.warn(
        `[factchecker] trimming code from ${src.length} to ${promptCode.length} chars for inline check`
      );
    }
    const userContent = `File: ${filePath}\nLanguage: ${language}\n\nCode:\n\`\`\`\n${promptCode}\n\`\`\`\n\nList every place where a comment or docstring does not match the implementation. Output JSON only.`;

    const raw = (await complete({
      model: FACTCHECKER_MODEL,
      system: INLINE_SYSTEM,
      user: userContent,
      temperature: 0.2,
      max_tokens: 2048,
    })) || '';

    let parsed;
    try {
      parsed = repairTruncatedJson(raw);
    } catch (err) {
      throw new Error(`Inline parser error: ${err.message}. Raw response:\n${raw}`);
    }
    const findings = Array.isArray(parsed.findings)
      ? parsed.findings.map(f => {
          const line = typeof f.line === 'number' ? f.line : undefined;
          return {
            filePath,
            line,
            codeSnippet: f.codeSnippet
              ? String(f.codeSnippet)
              : extractSnippet(src, line),
            claim:      String(f.claim      ?? ''),
            reality:    String(f.reality    ?? ''),
            severity:   ['low','medium','high'].includes(String(f.severity).toLowerCase())
                          ? String(f.severity).toLowerCase() : 'medium',
            suggestion: String(f.suggestion ?? ''),
          };
        })
      : [];

    return { findings, summary: typeof parsed.summary === 'string' ? parsed.summary : '' };
  };

  try {
    return await performRequest(code);
  } catch (err) {
    console.error('[factchecker] inline check error:', err.message);
    if (allowChunk && code.length > 4000) {
      console.warn('[factchecker] falling back to chunked inline analysis');
      // split at nearest newline around midpoint
      const mid = Math.floor(code.length / 2);
      const splitPos = code.lastIndexOf('\n', mid) || mid;
      const left = code.slice(0, splitPos);
      const right = code.slice(splitPos);
      let leftRes = { findings: [], summary: '' };
      let rightRes = { findings: [], summary: '' };
      try {
        leftRes = await checkInlineComments(left, filePath, language, false);
      } catch (e) {
        console.error('[factchecker] chunk-left analysis failed:', e.message);
      }
      try {
        rightRes = await checkInlineComments(right, filePath, language, false);
      } catch (e) {
        console.error('[factchecker] chunk-right analysis failed:', e.message);
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

// ─── Pass 2: External document check ─────────────────────────────────────────

// CHANGED: now also captures docSection and docPage from the model response
// and attaches filePath to each finding so the UI knows which code file
// the external doc was compared against.
async function checkDocAgainstCode(code, filePath, doc) {
  // trim both document and code for the prompt
  const docText = doc.content.length > 6000 ? doc.content.slice(0, 6000) + '\n...<TRUNCATED>...' : doc.content;
  let codeSnippet = code;
  if (code.length > 4000) {
    codeSnippet = require('../core/parser').trimCodeForPrompt(code, 4000);
    console.warn(`[factchecker] trimming code to ${codeSnippet.length} chars for doc check (${doc.name})`);
  }
  const userContent = `Document name: ${doc.name}\n\nDocument content:\n${docText}\n\n---\n\nActual source code (file: ${filePath}):\n\`\`\`\n${codeSnippet}\n\`\`\`\n\nList every discrepancy between the document and the code. Output JSON only.`;

  const raw     = (await complete({
    model: FACTCHECKER_MODEL,
    system: DOC_SYSTEM,
    user: userContent,
    temperature: 0.2,
    max_tokens: 2048,
  })) || '';

  let parsed;
  try {
    parsed = repairTruncatedJson(raw);
  } catch (err) {
    throw new Error(`Doc parser error (${doc.name}): ${err.message}. Raw response:\n${raw}`);
  }

  const findings = Array.isArray(parsed.findings)
    ? parsed.findings.map(f => ({
        filePath,                                    // CHANGED: attach filePath
        line:       undefined,                       // external docs have no code line numbers
        codeSnippet: undefined,                      // no specific code line to point at
        claim:      String(f.claim      ?? ''),
        reality:    String(f.reality    ?? ''),
        severity:   ['low','medium','high'].includes(String(f.severity).toLowerCase())
                      ? String(f.severity).toLowerCase() : 'medium',
        suggestion: String(f.suggestion ?? ''),
        docSource:  doc.name,                        // which document raised this
        docSection: f.docSection                     // CHANGED: section heading in the doc
                      ? String(f.docSection)
                      : 'unknown',
        docPage:    typeof f.docPage === 'number'    // CHANGED: page number in the doc
                      ? f.docPage
                      : null,
      }))
    : [];

  const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
  return { findings, summary };
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * @param {object}   payload
 * @param {string}   payload.code
 * @param {string}   payload.filePath
 * @param {string}   payload.language
 * @param {Array}    [payload.docs]  — [{ name: string, content: string }]
 * @returns {Promise<object>}
 */
async function run(payload) {
  const { code, filePath, language, docs = [] } = payload;

  let allFindings = [];
  const summaryParts = [];
  let inlineError = null;

  // ── Pass 1: Inline comments ───────────────────────────────────────────────
  try {
    const { findings, summary } = await checkInlineComments(code, filePath, language);
    allFindings.push(...findings);
    if (summary) summaryParts.push(summary);
  } catch (err) {
    inlineError = err.message;
    console.error('[factchecker] inline check error:', err.message);
  }

  if (inlineError) {
    summaryParts.push(`Inline check failed: ${inlineError}`);
  }

  // ── Pass 2: External documents (one call per doc) ─────────────────────────
  for (const doc of docs) {
    if (!doc?.content) continue;
    let docError = null;
    try {
      const { findings, summary } = await checkDocAgainstCode(code, filePath, doc);
      allFindings.push(...findings);
      if (summary) summaryParts.push(`[${doc.name}] ${summary}`);
    } catch (err) {
      docError = err.message;
      console.error(`[factchecker] doc check error (${doc.name}):`, err.message);
      // try again with trimmed code if error occurs
      try {
        console.warn(`[factchecker] retrying doc check (${doc.name}) with trimmed code`);
        const trimmed = require('../core/parser').trimCodeForPrompt(code, 4000);
        const { findings, summary } = await checkDocAgainstCode(trimmed, filePath, doc);
        allFindings.push(...findings);
        if (summary) summaryParts.push(`[${doc.name}] ${summary} (partial)`);
        docError = null; // succeed on retry
      } catch (err2) {
        console.error(`[factchecker] doc retry failed (${doc.name}):`, err2.message);
      }
    }
    if (docError) {
      summaryParts.push(`[${doc.name}] document check failed: ${docError}`);
    }
  }

  const hasHigh   = allFindings.some(f => f.severity === 'high');
  const hasMedium = allFindings.some(f => f.severity === 'medium');
  const status    = hasHigh   ? 'fail'
                  : hasMedium ? 'warn'
                  : allFindings.length > 0 ? 'warn'
                  : 'pass';

  const summary = summaryParts.join(' | ') || 'Fact-check complete.';

  return { agent: 'factchecker', status, findings: allFindings, summary };
}

module.exports = { run };