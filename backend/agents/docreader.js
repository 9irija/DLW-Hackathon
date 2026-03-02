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

function splitSections(text) {
  const lines = String(text).split("\n");
  const sections = [];
  let current = { title: "unknown", startLine: 1, endLine: lines.length, content: "" };

  lines.forEach((line, idx) => {
    const match = line.match(/^(#+)\s*(.*)/);
    if (match) {
      if (current.content) {
        current.endLine = idx;
        sections.push(current);
      }
      current = { title: match[2] || "unknown", startLine: idx + 1, endLine: lines.length, content: "" };
    }
    current.content += line + "\n";
  });
  if (current.content && !sections.includes(current)) {
    current.endLine = lines.length;
    sections.push(current);
  }
  return sections.map(({ title, startLine, endLine }) => ({ title, startLine, endLine }));
}

// helper that converts a doc payload to plain text if necessary
async function extractText(doc) {
  // doc.content may be a string or base64-encoded binary
  let buf;
  if (Buffer.isBuffer(doc.content)) {
    buf = doc.content;
  } else if (typeof doc.content === 'string' && /^(?:[A-Za-z0-9+/=]+)$/i.test(doc.content) && doc.content.length > 100) {
    // heuristics: long base64 string
    try { buf = Buffer.from(doc.content, 'base64'); } catch { buf = null; }
  }

  const name = (doc.name || '').toLowerCase();
  if (name.endsWith('.pdf') && buf) {
    try {
      const { text } = await pdfParse(buf);
      return text;
    } catch (e) {
      console.warn(`[docreader] pdf parse failed for ${doc.name}: ${e.message}`);
      return '';
    }
  } else if (name.endsWith('.docx') && buf) {
    try {
      const result = await mammoth.extractRawText({ buffer: buf });
      return result.value;
    } catch (e) {
      console.warn(`[docreader] docx parse failed for ${doc.name}: ${e.message}`);
      return '';
    }
  }

  // default: return as string
  return String(doc.content || '');
}

async function run(payload) {
  const { docs = [] } = payload;
  const results = [];
  try {
    for (const doc of docs) {
      const text = await extractText(doc);
      const sections = splitSections(text);
      const lineCount = text.split("\n").length;
      const pageCount = Math.max(1, Math.ceil(lineCount / 50));
      results.push({ name: doc.name, pageCount, sections });
    }
    return { agent: 'docreader', status: 'pass', docs: results, summary: `Processed ${results.length} document(s)` };
  } catch (err) {
    return { agent: 'docreader', status: 'fail', docs: [], summary: `Doc reader error: ${err.message}` };
  }
}

module.exports = { run, extractText };