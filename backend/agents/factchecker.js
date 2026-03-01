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
 *     docSource so the UI can show which document raised the issue.
 *
 * Output shape:
 * {
 *   agent: "factchecker",
 *   status: "pass" | "warn" | "fail",
 *   findings: [{ line, claim, reality, severity, suggestion, docSource? }],
 *   summary: string
 * }
 */

const openai = require('../core/openai');

// ─── Prompts ──────────────────────────────────────────────────────────────────

const INLINE_SYSTEM = `You are a fact-checker for source code. Compare every comment, docstring, JSDoc, and inline documentation in the code with what the code actually does.

For each mismatch output one finding with:
- line: approximate line number (number) where the comment/docs appear
- claim: what the comment/documentation says
- reality: what the code actually does (brief)
- severity: "low" | "medium" | "high"
- suggestion: how to fix the comment or the code (one short sentence)

If there are no mismatches, return an empty findings array.

Respond with valid JSON only (no markdown, no extra text):
{"findings": [{"line": number, "claim": string, "reality": string, "severity": string, "suggestion": string}], "summary": string}
The summary should be one sentence: either "All comments match the implementation." or a brief overview of what you found.`;

const DOC_SYSTEM = `You are a documentation accuracy checker. You are given an external document (README, API spec, design doc, etc.) and the actual source code it describes.

Identify every place where the document makes a claim that does not match what the code actually does.

For each discrepancy output one finding with:
- claim: what the document says (quote or paraphrase)
- reality: what the code actually does
- severity: "low" | "medium" | "high"
- suggestion: how to fix the document or the code (one short sentence)

Do not include a "line" field — external documents do not have code line numbers.
If the document accurately describes the code, return an empty findings array.

Respond with valid JSON only (no markdown, no extra text):
{"findings": [{"claim": string, "reality": string, "severity": string, "suggestion": string}], "summary": string}
The summary should be one sentence describing how well the document matches the code.`;

// ─── Pass 1: Inline comment check ────────────────────────────────────────────

async function checkInlineComments(code, filePath, language) {
  const userContent = `File: ${filePath}\nLanguage: ${language}\n\nCode:\n\`\`\`\n${code}\n\`\`\`\n\nList every place where a comment or docstring does not match the implementation. Output JSON only.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    max_tokens: 2048,
    messages: [
      { role: 'system', content: INLINE_SYSTEM },
      { role: 'user',   content: userContent   },
    ],
  });

  const raw     = completion.choices?.[0]?.message?.content?.trim() ?? '';
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const parsed  = JSON.parse(cleaned);

  const findings = Array.isArray(parsed.findings)
    ? parsed.findings.map(f => ({
        line:       typeof f.line === 'number' ? f.line : undefined,
        claim:      String(f.claim      ?? ''),
        reality:    String(f.reality    ?? ''),
        severity:   ['low','medium','high'].includes(String(f.severity).toLowerCase())
                      ? String(f.severity).toLowerCase() : 'medium',
        suggestion: String(f.suggestion ?? ''),
      }))
    : [];

  return { findings, summary: typeof parsed.summary === 'string' ? parsed.summary : '' };
}

// ─── Pass 2: External document check ─────────────────────────────────────────

async function checkDocAgainstCode(code, doc) {
  const userContent = `Document name: ${doc.name}\n\nDocument content:\n${doc.content.slice(0, 6000)}\n\n---\n\nActual source code:\n\`\`\`\n${code.slice(0, 4000)}\n\`\`\`\n\nList every discrepancy between the document and the code. Output JSON only.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    max_tokens: 2048,
    messages: [
      { role: 'system', content: DOC_SYSTEM  },
      { role: 'user',   content: userContent },
    ],
  });

  const raw     = completion.choices?.[0]?.message?.content?.trim() ?? '';
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const parsed  = JSON.parse(cleaned);

  const findings = Array.isArray(parsed.findings)
    ? parsed.findings.map(f => ({
        line:       undefined,           // external docs have no code line numbers
        claim:      String(f.claim      ?? ''),
        reality:    String(f.reality    ?? ''),
        severity:   ['low','medium','high'].includes(String(f.severity).toLowerCase())
                      ? String(f.severity).toLowerCase() : 'medium',
        suggestion: String(f.suggestion ?? ''),
        docSource:  doc.name,            // which document raised this
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

  // ── Pass 1: Inline comments ───────────────────────────────────────────────
  try {
    const { findings, summary } = await checkInlineComments(code, filePath, language);
    allFindings.push(...findings);
    if (summary) summaryParts.push(summary);
  } catch (err) {
    console.error('[factchecker] inline check error:', err.message);
    summaryParts.push(`Inline check failed: ${err.message}`);
  }

  // ── Pass 2: External documents (one call per doc) ─────────────────────────
  for (const doc of docs) {
    if (!doc?.content) continue;
    try {
      const { findings, summary } = await checkDocAgainstCode(code, doc);
      allFindings.push(...findings);
      if (summary) summaryParts.push(`[${doc.name}] ${summary}`);
    } catch (err) {
      console.error(`[factchecker] doc check error (${doc.name}):`, err.message);
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
