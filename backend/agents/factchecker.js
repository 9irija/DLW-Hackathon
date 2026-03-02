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
const parser = require('./parser');
const docreader = require('./docreader');

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

First, scan the document for any explicit requirements or rules about the code.  These may appear as numbered features (FR-1, FR-2, …) or as ordinary sentences containing words like "must", "should", "shall", "required", "need to" etc.  Treat such statements as claims about how the code should behave.

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
  // Preprocess with parser to break into logical segments.  This avoids
  // overwhelming the factchecker with a huge monolithic file and gives more
  // accurate line offsets.
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

  // existing performRequest logic extracted so we can reuse per segment
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

    const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
    return { findings, summary };
  };

  for (const seg of segments) {
    try {
      const { findings, summary } = await performRequest(seg.snippet);
      // adjust line numbers
      findings.forEach(f => {
        if (typeof f.line === 'number') f.line += seg.lineStart - 1;
      });
      allFindings.push(...findings);
      if (summary) summaries.push(summary);
    } catch (err) {
      console.error('[factchecker] inline check error:', err.message);
      // fallback to chunking as before on the full segment if allowed
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

// CHANGED: now also captures docSection and docPage from the model response
// and attaches filePath to each finding so the UI knows which code file
// the external doc was compared against.
async function checkDocAgainstCode(code, filePath, doc, meta) {
  // meta: optional object from docreader containing sections & pageCount
  // extract any obvious requirement lines ourselves to emphasise to the model
  let plainText = doc.content;
  try {
    // if doc.content is base64, convert to text using the docreader helper which
    // understands PDF/DOCX etc. falling back to utf8 on failure.
    if (typeof plainText === 'string' && /^[A-Za-z0-9+/=\s]+$/.test(plainText) && plainText.length > 100) {
      try {
        const buf = Buffer.from(plainText, 'base64');
        plainText = await require('./docreader').extractText({ name: doc.name, content: buf });
      } catch (e) {
        plainText = Buffer.from(plainText, 'base64').toString('utf8');
      }
    }
  } catch {};
  const ruleRegex = /(?:FR-\d+|\bmust\b|\bshould\b|\bshall\b|\brequired\b|\bneed to\b)/i;
  const explicitRules = plainText.split('\n').filter(l => ruleRegex.test(l));

  const snippets = [];
  if (meta && Array.isArray(meta.sections) && meta.sections.length) {
    // iterate over each section separately so we can label them
    for (const section of meta.sections) {
      snippets.push({
        title: section.title || 'unknown',
        text: plainText.slice(
          section.startLine - 1 < 0 ? 0 : section.startLine - 1,
          section.endLine
        ),
        page: meta.pageCount ? Math.ceil(section.startLine / (plainText.split('\n').length / meta.pageCount)) : null,
      });
    }
  } else {
    snippets.push({ title: 'full', text: plainText, page: null });
  }

  const aggregated = { findings: [], summary: '' };
  // remember any requirements we pulled earlier so they can be surfaced
  const ruleFindings = explicitRules.map(r => ({
    filePath,
    line: undefined,
    codeSnippet: undefined,
    claim: r.trim(),
    reality: 'Code appears to satisfy this requirement.',
    severity: 'low',
    suggestion: '',
    docSource: doc.name,
    docSection: 'requirements',
    docPage: null,
  }));

  for (const snip of snippets) {
    let docText = snip.text;
    if (docText.length > 6000) docText = docText.slice(0, 6000) + '\n...<TRUNCATED>...';
    if (explicitRules.length) {
      docText = `Explicit requirements found in document:\n- ${explicitRules.join('\n- ')}\n\n` + docText;
    }
    let codeSnippet = code;
    if (code.length > 4000) {
      codeSnippet = require('../core/parser').trimCodeForPrompt(code, 4000);
      console.warn(`[factchecker] trimming code to ${codeSnippet.length} chars for doc check (${doc.name})`);
    }
    const userContent = `Document name: ${doc.name}\nSection: ${snip.title}\n\nDocument content:\n${docText}\n\n---\n\nActual source code (file: ${filePath}):\n\`\`\`\n${codeSnippet}\n\`\`\`\n\nList every discrepancy between the document and the code. Output JSON only.`;

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
      // rather than bubble up an exception that aborts the whole doc check,
      // log and continue to the next snippet so we still return any
      // explicit rule findings we already extracted.
      console.error(`[@factchecker] doc parser error (${doc.name} section ${snip.title}): ${err.message}. Raw response:\n${raw}`);
      continue; // skip to next snippet
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

    aggregated.findings.push(...findings);
    if (parsed.summary) {
      aggregated.summary += aggregated.summary ? ` | [${snip.title}] ${parsed.summary}` : `[${snip.title}] ${parsed.summary}`;
    }
  }


  return aggregated;
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

  // preprocess docs to obtain metadata (sections/pages)
  const metaMap = {};
  if (docs.length) {
    try {
      const dr = await docreader.run({ docs });
      if (dr?.docs) {
        dr.docs.forEach(d => { if (d?.name) metaMap[d.name] = d; });
      }
    } catch (err) {
      console.error('[factchecker] docreader error:', err.message);
    }
  }

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

  // ── Pass 2: External documents (one call per doc/section) ────────────────
  for (const doc of docs) {
    if (!doc?.content) continue;
    const meta = metaMap[doc.name] || null;

    // regardless of whether the model check succeeds, surface any explicit
    // rules we can immediately identify so the UI can display them.
    try {
      const plain = await require('./docreader').extractText(doc);
      const ruleRegex = /(?:FR-\d+|\b(?:must|should|shall|required|need to|ensure)\b)/i;
      const explicitRules = String(plain || '')
        .split('\n')
        .filter(l => ruleRegex.test(l));
      if (explicitRules.length) {
        const ruleFindings = explicitRules.map(r => ({
          filePath,
          line: undefined,
          codeSnippet: undefined,
          claim: r.trim(),
          reality: 'Code appears to satisfy this requirement.',
          severity: 'low',
          suggestion: '',
          docSource: doc.name,
          docSection: 'requirements',
          docPage: null,
        }));
        allFindings.push(...ruleFindings);
        summaryParts.push(`[${doc.name}] ${ruleFindings.length} explicit rule${ruleFindings.length>1?'s':''} detected`);
      }
    } catch (ex) {
      console.error('[factchecker] rule extraction failed:', ex.message);
    }

    let docError = null;
    try {
      const { findings, summary } = await checkDocAgainstCode(code, filePath, doc, meta);
      allFindings.push(...findings);
      if (summary) summaryParts.push(`[${doc.name}] ${summary}`);
    } catch (err) {
      docError = err.message;
      console.error(`[factchecker] doc check error (${doc.name}):`, err.message);
      // try again with trimmed code if error occurs
      try {
        console.warn(`[factchecker] retrying doc check (${doc.name}) with trimmed code`);
        const trimmed = require('../core/parser').trimCodeForPrompt(code, 4000);
        const { findings, summary } = await checkDocAgainstCode(trimmed, filePath, doc, meta);
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