/**
 * factchecker — two-pass accuracy checker:
 *
 * Flow: code is processed by parser first (for segments), then each segment
 * is checked; docs are read via docreader (metadata + extractText), then
 * each doc/section is compared against code. Orchestrator runs builder first,
 * then factchecker receives enrichedPayload (code, filePath, language, docs).
 *
 *   Pass 1 — Inline comments (always runs)
 *     Parser runs on code → segments; each segment is compared (comment vs implementation).
 *
 *   Pass 2 — External documentation (runs when payload.docs is provided)
 *     Docreader runs on payload.docs → metadata/sections; extractText gives plain text;
 *     each doc/section is compared against the actual code.
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
const parser = require('./parser');
const docreader = require('./docreader');

// Default Codex (Responses API). Override with FACTCHECKER_MODEL in .env to use Chat Completions (e.g. gpt-4o-mini).
const FACTCHECKER_MODEL = process.env.FACTCHECKER_MODEL || process.env.CODEX_MODEL || 'gpt-5-codex';

// Max concurrent LLM calls for doc-section checks (reduces wait after docreader).
const DOC_SECTION_CONCURRENCY = Math.min(Number(process.env.FACTCHECKER_DOC_CONCURRENCY) || 4, 8);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Run async tasks with a concurrency limit. */
async function runWithConcurrency(tasks, limit) {
  const results = [];
  const executing = new Set();
  for (let i = 0; i < tasks.length; i++) {
    const p = Promise.resolve().then(() => tasks[i]());
    executing.add(p);
    const done = p.finally(() => { executing.delete(p); });
    results.push(done);
    if (executing.size >= limit) await Promise.race(executing);
  }
  return Promise.all(results);
}

/**
 * Given the full source code string and a line number, extracts a small window
 * of lines (±contextLines) around that line to use as a codeSnippet in the
 * finding. Returns an empty string if line is not provided.
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

/**
 * Slice a plain-text document by line range (1-based, inclusive).
 * Used to extract section content from docreader metadata.
 */
function sliceByLines(text, startLine, endLine) {
  const lines = text.split('\n');
  return lines.slice(
    Math.max(0, startLine - 1),
    Math.min(lines.length, endLine)
  ).join('\n');
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

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

const DOC_SYSTEM = `You are a documentation accuracy checker. You are given an external document (README, API spec, design doc, etc.) and the actual source code it describes.

First, scan the document for any explicit requirements or rules about the code. These may appear as numbered features (FR-1, FR-2, AR-1, VR-1, PR-1, UR-1 etc.) or as ordinary sentences containing words like "must", "should", "shall", "required", "need to" etc. Treat such statements as claims about how the code should behave.

Identify every place where the document makes a claim or requirement that does not match what the code actually does.

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

const RULE_VERIFY_SYSTEM = `You are a strict requirements verifier. Only report findings where the code fails or cannot be confirmed to meet a requirement. If the code clearly satisfies a requirement, do not include it in findings.`;

// ─── JSON parsing helpers ─────────────────────────────────────────────────────

/**
 * Attempt to repair and parse JSON output from an LLM response.
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

// ─── Pass 1: Inline comment check ────────────────────────────────────────────

async function checkInlineComments(code, filePath, language, allowChunk = true) {
  let segments = [{ snippet: code, lineStart: 1, lineEnd: code.split('\n').length }];
  try {
    const pr = await parser.run({ code });
    if (pr && Array.isArray(pr.parsed) && pr.parsed.length) {
      segments = pr.parsed.map(s => ({
        snippet: s.snippet,
        lineStart: s.lineStart || 1,
        lineEnd: s.lineEnd || 0,
      }));
    }
  } catch (e) {
    console.warn('[factchecker] parser step failed, continuing with full code');
  }

  const allFindings = [];
  const summaries = [];

  const performRequest = async (src) => {
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
      max_tokens: 4096,
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

    const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
    return { findings, summary };
  };

  const totalSegments = segments.length;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (totalSegments > 1) {
      console.warn(`[factchecker] Pass 1 (inline): segment ${i + 1}/${totalSegments}...`);
    }
    try {
      const { findings, summary } = await performRequest(seg.snippet);
      findings.forEach(f => {
        if (typeof f.line === 'number') f.line += seg.lineStart - 1;
      });
      allFindings.push(...findings);
      if (summary) summaries.push(summary);
    } catch (err) {
      console.error('[factchecker] inline check error:', err.message);
      if (allowChunk && seg.snippet.length > 4000) {
        console.warn('[factchecker] falling back to chunked inline analysis');
        const mid = Math.floor(seg.snippet.length / 2);
        const splitPos = seg.snippet.lastIndexOf('\n', mid) || mid;
        const left = seg.snippet.slice(0, splitPos);
        const right = seg.snippet.slice(splitPos);
        let leftRes = { findings: [], summary: '' };
        let rightRes = { findings: [], summary: '' };
        try { leftRes = await checkInlineComments(left, filePath, language, false); } catch (e) { console.error('[factchecker] chunk-left analysis failed:', e.message); }
        try { rightRes = await checkInlineComments(right, filePath, language, false); } catch (e) { console.error('[factchecker] chunk-right analysis failed:', e.message); }
        const leftLines = left.split('\n').length;
        rightRes.findings.forEach(f => { if (typeof f.line === 'number') f.line += leftLines; });
        allFindings.push(...leftRes.findings, ...rightRes.findings);
        if (leftRes.summary) summaries.push(leftRes.summary);
        if (rightRes.summary) summaries.push(rightRes.summary);
      }
    }
  }

  return { findings: allFindings, summary: summaries.join(' | ') };
}

// ─── Pass 2: External document check ─────────────────────────────────────────

async function checkDocAgainstCode(code, filePath, doc, meta, plainText) {
  // plainText is passed in from run() so we don't decode twice.
  // Fall back to doc.content as string if not provided.
  const fullText = plainText || String(doc.content || '');

  const snippets = [];
  if (meta && Array.isArray(meta.sections) && meta.sections.length) {
    for (const section of meta.sections) {
      // Use sliceByLines so startLine/endLine are treated as line numbers, not char offsets.
      snippets.push({
        title: section.title || 'unknown',
        text: sliceByLines(fullText, section.startLine, section.endLine),
        page: meta.pageCount
          ? Math.ceil(section.startLine / (fullText.split('\n').length / meta.pageCount))
          : null,
      });
    }
  } else {
    snippets.push({ title: 'full', text: fullText, page: null });
  }

  const aggregated = { findings: [], summary: '' };
  const totalSections = snippets.length;

  let codeSnippet = code;
  if (code.length > 4000) {
    codeSnippet = require('../core/parser').trimCodeForPrompt(code, 4000);
    console.warn(`[factchecker] trimming code to ${codeSnippet.length} chars for doc check (${doc.name})`);
  }

  if (totalSections > 1) {
    console.warn(`[factchecker] Pass 2 (doc vs code): ${doc.name}, ${totalSections} sections (concurrency ${DOC_SECTION_CONCURRENCY})...`);
  }

  const sectionTasks = snippets.map((snip, idx) => async () => {
    if (totalSections > 1 && (idx + 1) % 5 === 0 || idx === totalSections - 1) {
      console.warn(`[factchecker] Pass 2: section ${idx + 1}/${totalSections} (${snip.title.slice(0, 40)}...)`);
    }
    let docText = snip.text;
    if (docText.length > 6000) docText = docText.slice(0, 6000) + '\n...<TRUNCATED>...';

    const userContent = `Document name: ${doc.name}\nSection: ${snip.title}\n\nDocument content:\n${docText}\n\n---\n\nActual source code (file: ${filePath}):\n\`\`\`\n${codeSnippet}\n\`\`\`\n\nList every discrepancy between the document and the code. Output JSON only.`;

    const raw = (await complete({
      model: FACTCHECKER_MODEL,
      system: DOC_SYSTEM,
      user: userContent,
      temperature: 0.2,
      max_tokens: 4096,
    })) || '';

    let parsed;
    try {
      parsed = repairTruncatedJson(raw);
    } catch (err) {
      console.error(`[factchecker] doc parser error (${doc.name} section ${snip.title}): ${err.message}. Raw response:\n${raw}`);
      return { findings: [], summary: '' };
    }

    const findings = Array.isArray(parsed.findings)
      ? parsed.findings.map(f => ({
          filePath,
          line: undefined,
          codeSnippet: undefined,
          claim:      String(f.claim      ?? ''),
          reality:    String(f.reality    ?? ''),
          severity:   ['low','medium','high'].includes(String(f.severity).toLowerCase())
                        ? String(f.severity).toLowerCase() : 'medium',
          suggestion: String(f.suggestion ?? ''),
          docSource:  doc.name,
          docSection: snip.title || (f.docSection ? String(f.docSection) : 'unknown'),
          docPage:    snip.page != null ? snip.page : (typeof f.docPage === 'number' ? f.docPage : null),
        }))
      : [];

    const summary = parsed.summary ? `[${snip.title}] ${parsed.summary}` : '';
    return { findings, summary };
  });

  const sectionResults = await runWithConcurrency(sectionTasks, DOC_SECTION_CONCURRENCY);
  for (const { findings, summary } of sectionResults) {
    aggregated.findings.push(...findings);
    if (summary) {
      aggregated.summary += aggregated.summary ? ` | ${summary}` : summary;
    }
  }

  return aggregated;
}

// ─── Pass 2b: Explicit requirement verification ───────────────────────────────

/**
 * Extracts requirement lines from a doc's plain text, then sends them to the
 * LLM alongside the actual code for genuine verification. Only findings where
 * the code fails or cannot be confirmed to satisfy the requirement are returned.
 */
async function verifyExplicitRules(plainText, code, filePath, doc) {
  // Match lines that contain a requirement tag or keyword.
  // Filter out lines that are just a lone number (PDF page/item counters)
  // or are very short fragments with no meaningful content.
  const ruleRegex = /(?:FR-\d+|AR-\d+|VR-\d+|PR-\d+|UR-\d+|\b(?:must|should|shall|required|need to|ensure)\b)/i;
  const explicitRules = String(plainText || '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => ruleRegex.test(l) && l.length > 15);

  if (!explicitRules.length) return { findings: [], summary: '' };

  const trimmedCode = require('../core/parser').trimCodeForPrompt(code, 6000);

  const userContent = `You are verifying whether source code satisfies a list of requirements extracted from a document.

For each requirement below, check whether the code actually satisfies it.

Requirements:
${explicitRules.map((r, i) => `${i + 1}. ${r}`).join('\n')}

Source code (file: ${filePath}):
\`\`\`
${trimmedCode}
\`\`\`

For each requirement, output a finding ONLY if the code does NOT satisfy it, or if you cannot determine whether it does.
If the code clearly satisfies a requirement, omit it from findings entirely.

Respond with valid JSON only (no markdown, no extra text):
{"findings": [{"ruleIndex": number, "claim": string, "reality": string, "severity": "low"|"medium"|"high", "suggestion": string}], "summary": string}`;

  const raw = (await complete({
    model: FACTCHECKER_MODEL,
    system: RULE_VERIFY_SYSTEM,
    user: userContent,
    temperature: 0.1,
    max_tokens: 4096,
  })) || '';

  let parsed;
  try {
    parsed = repairTruncatedJson(raw);
  } catch (err) {
    console.error(`[factchecker] rule verification parse error (${doc.name}):`, err.message);
    return { findings: [], summary: '' };
  }

  const findings = (parsed.findings || []).map(f => ({
    filePath,
    line: undefined,
    codeSnippet: undefined,
    claim: explicitRules[Number(f.ruleIndex) - 1] ?? String(f.claim ?? ''),
    reality: String(f.reality ?? ''),
    severity: ['low', 'medium', 'high'].includes(String(f.severity).toLowerCase())
      ? String(f.severity).toLowerCase() : 'medium',
    suggestion: String(f.suggestion ?? ''),
    docSource: doc.name,
    docSection: 'requirements',
    docPage: null,
  }));

  return {
    findings,
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
  };
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

  // Declare shared accumulators first so the docreader block can safely push to them
  let allFindings = [];
  const summaryParts = [];
  let inlineError = null;

  // preprocess docs to obtain metadata (sections/pages)
  const metaMap = {};
  if (docs.length) {
    try {
      console.warn('[factchecker] Running docreader for', docs.length, 'doc(s)...');
      const dr = await docreader.run({ docs });
      if (dr?.docs) {
        dr.docs.forEach(d => { if (d?.name) metaMap[d.name] = d; });
      }
      // Surface partial parse failures so the UI can show them in the summary
      if (dr?.status !== 'pass' && dr?.summary) {
        summaryParts.push(`[docreader] ${dr.summary}`);
      }
      console.warn('[factchecker] Docreader done. Starting Pass 1 (inline) then Pass 2 (doc vs code).');
    } catch (err) {
      console.error('[factchecker] docreader error:', err.message);
      summaryParts.push(`[docreader] Failed to parse document(s): ${err.message}`);
    }
  }

  // ── Pass 1: Inline comments ───────────────────────────────────────────────
  console.warn('[factchecker] Pass 1: inline comments vs code...');
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

  // ── Pass 2: External documents ────────────────────────────────────────────
  if (docs.length) {
    console.warn(`[factchecker] Pass 2: ${docs.length} doc(s) vs code (requirements + sections)...`);
  }
  for (const doc of docs) {
    if (!doc?.content) continue;
    const meta = metaMap[doc.name] || null;

    // Extract plain text once and reuse for both passes.
    let plainText = '';
    try {
      plainText = await require('./docreader').extractText(doc);
    } catch (ex) {
      console.error(`[factchecker] text extraction failed (${doc.name}):`, ex.message);
    }

    // ── Pass 2a: Explicit requirement verification (LLM-based) ──────────────
    try {
      console.warn(`[factchecker] Pass 2a: verifying explicit requirements (${doc.name})...`);
      const { findings, summary } = await verifyExplicitRules(plainText, code, filePath, doc);
      allFindings.push(...findings);
      if (summary) summaryParts.push(`[${doc.name}] requirements: ${summary}`);
      else if (findings.length === 0) {
        summaryParts.push(`[${doc.name}] all explicit requirements satisfied`);
      }
    } catch (ex) {
      console.error(`[factchecker] rule verification failed (${doc.name}):`, ex.message);
    }

    // ── Pass 2b: Full document vs code check (per section) ───────────────────
    const normalisedDoc = { name: doc.name, content: plainText };

    let docError = null;
    try {
      const { findings, summary } = await checkDocAgainstCode(code, filePath, normalisedDoc, meta, plainText);
      allFindings.push(...findings);
      if (summary) summaryParts.push(`[${doc.name}] ${summary}`);
    } catch (err) {
      docError = err.message;
      console.error(`[factchecker] doc check error (${doc.name}):`, err.message);
      // retry with trimmed code
      try {
        console.warn(`[factchecker] retrying doc check (${doc.name}) with trimmed code`);
        const trimmed = require('../core/parser').trimCodeForPrompt(code, 4000);
        const { findings, summary } = await checkDocAgainstCode(trimmed, filePath, normalisedDoc, meta, plainText);
        allFindings.push(...findings);
        if (summary) summaryParts.push(`[${doc.name}] ${summary} (partial)`);
        docError = null;
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