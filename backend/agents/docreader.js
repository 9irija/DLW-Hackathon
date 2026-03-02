/**
 * docreader — ingest external documentation and produce structural metadata.
 *
 * Role: Fact Checker → [DocReader] → Fact Checker (sections/pages preserved)
 *
 * Responsibilities:
 *   1. Analyse each document, split it into logical sections (headings).
 *   2. Estimate pagination information when possible.
 *   3. Return a metadata object that helps the factchecker attribute findings to
 *      a particular section or page in the UI.
 *
 * Output shape:
 * {
 *   agent: "docreader",
 *   status: "pass" | "warn" | "fail",
 *   docs: [
 *     {
 *       name: string,
 *       pageCount: number,
 *       sections: [{ title: string, startLine: number, endLine: number }]
 *     }
 *   ],
 *   summary: string
 * }
 */

const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Strips non-ASCII/control characters and collapses excessive whitespace
 * from PDF/DOCX extracted text so downstream agents receive clean input.
 */
function cleanText(text) {
  return String(text || '')
    .replace(/[^\x20-\x7E\n\r\t]/g, ' ')
    .replace(/[ \t]{3,}/g, '  ')
    .replace(/\n{4,}/g, '\n\n')
    // rejoin lines where a lone number on its own line precedes an FR/AR/VR/PR/UR tag
    .replace(/(\d+)\n((?:FR|AR|VR|PR|UR)-\d+)/g, '$1 $2')
    // rejoin wrapped continuation lines (lines that don't start a new sentence/tag)
    .replace(/([a-z,])\n(?!(?:\d+[\. ]|FR-|AR-|VR-|PR-|UR-|[A-Z]{2,}))/g, '$1 ')
    .trim();
}

function splitSections(text) {
  const lines = String(text).split('\n');
  const sections = [];
  let current = { title: 'preamble', startLine: 1, endLine: lines.length, content: '' };

  const isHeading = (line, nextLine = '') => {
    const trimmed = line.trim();
    if (!trimmed) return false;

    // Markdown headings
    if (/^#{1,6}\s+/.test(trimmed)) return true;

    // Numbered sections: 1. Title / 1.1 Title / 1.1.1 Title
    if (/^\d+(\.\d+)*\.?\s+[A-Z]/.test(trimmed)) return true;

    // ALL CAPS line (min 4 chars, not just an acronym or code)
    if (trimmed.length >= 4 && trimmed === trimmed.toUpperCase() && /[A-Z]{3,}/.test(trimmed) && !/[=<>{}();]/.test(trimmed)) return true;

    // Title Case line followed by a blank line (common PDF heading pattern)
    if (/^[A-Z][a-zA-Z\s]{3,}$/.test(trimmed) && nextLine.trim() === '') return true;

    return false;
  };

  lines.forEach((line, idx) => {
    if (idx > 0 && isHeading(line, lines[idx + 1] || '')) {
      current.endLine = idx;
      sections.push(current);
      const title = line.trim().replace(/^#+\s*/, '') || 'unknown';
      current = { title, startLine: idx + 1, endLine: lines.length, content: '' };
    }
    current.content += line + '\n';
  });

  current.endLine = lines.length;
  sections.push(current);

  return sections
    .filter(s => s.content.trim().length > 0)
    .map(({ title, startLine, endLine }) => ({ title, startLine, endLine }));
}

// Stricter base64 check — requires length and absence of spaces/punctuation
function isLikelyBase64(str) {
  return (
    typeof str === 'string' &&
    str.length > 200 &&
    /^[A-Za-z0-9+/]+=*$/.test(str.replace(/\s/g, ''))
  );
}

// ─── Text extraction ──────────────────────────────────────────────────────────

async function extractText(doc) {
  let buf = null;
  if (Buffer.isBuffer(doc.content)) {
    buf = doc.content;
  } else if (isLikelyBase64(doc.content)) {
    try { buf = Buffer.from(doc.content, 'base64'); } catch { buf = null; }
  }

  const name = (doc.name || '').toLowerCase();

  if (name.endsWith('.pdf') && buf) {
    try {
      const data = await pdfParse(buf);
      return { text: cleanText(data.text), pageCount: data.numpages };
    } catch (e) {
      console.error(`[docreader] pdf parse failed for ${doc.name}: ${e.message}`);
      throw new Error(`Failed to parse PDF "${doc.name}": ${e.message}`);
    }
  }

  if (name.endsWith('.docx') && buf) {
    try {
      const result = await mammoth.extractRawText({ buffer: buf });
      return { text: cleanText(result.value), pageCount: null };
    } catch (e) {
      console.error(`[docreader] docx parse failed for ${doc.name}: ${e.message}`);
      throw new Error(`Failed to parse DOCX "${doc.name}": ${e.message}`);
    }
  }

  // plain text / markdown / anything else
  const text = String(doc.content || '');
  return { text: cleanText(text), pageCount: null };
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function run(payload) {
  const { docs = [] } = payload;
  const results = [];
  const warnings = [];

  for (const doc of docs) {
    try {
      const { text, pageCount: rawPageCount } = await extractText(doc);
      const sections = splitSections(text);
      const lineCount = text.split('\n').length;
      // use real page count from pdf-parse when available, otherwise estimate
      const pageCount = rawPageCount ?? Math.max(1, Math.ceil(lineCount / 50));
      results.push({ name: doc.name, pageCount, sections });
    } catch (err) {
      console.error(`[docreader] failed to process ${doc.name}:`, err.message);
      warnings.push(doc.name);
      results.push({ name: doc.name, pageCount: 0, sections: [], error: err.message });
    }
  }

  const status = warnings.length === docs.length ? 'fail'
               : warnings.length > 0 ? 'warn'
               : 'pass';

  const summary = warnings.length
    ? `Processed ${results.length - warnings.length}/${docs.length} document(s). Failed: ${warnings.join(', ')}`
    : `Processed ${results.length} document(s)`;

  return { agent: 'docreader', status, docs: results, summary };
}

// Export extractText as a plain-string helper for external callers (e.g. factchecker)
module.exports = { run, extractText: async (doc) => (await extractText(doc)).text };