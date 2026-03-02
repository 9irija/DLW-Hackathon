/**
 * parser — lightweight code splitting agent
 *
 * Role: builder → [Parser] → Reasoner → Fact Checker
 *
 * Responsibilities:
 *   1. Take raw source code and break it into smaller, logically grouped
 *      segments (e.g. by function, class, export, or roughly every N lines).
 *   2. Provide a summary of how the code was partitioned.
 *   3. Supply the parsed structure to the Reasoner agent so that it can
 *      analyse each piece individually if necessary.
 *
 * Output shape:
 * {
 *   agent: "parser",
 *   status: "pass" | "warn" | "fail",
 *   parsed: [{ snippet, lineStart, lineEnd }],
 *   findings: [],           // reserved for future use
 *   summary: string
 * }
 */
const MAX_SEGMENT_LINES = 80;
const boundaryRegex = /^(?:\s*(?:\/\*\*|function\s|class\s|async function\s|export\b|(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:function|\()))/;

function splitByLogicalBoundaries(code) {
  const lines = String(code || '').split('\n');
  const segments = [];
  let start = 0;

  const flush = (end) => {
    if (end > start) {
      segments.push({
        snippet: lines.slice(start, end).join('\n'),
        lineStart: start + 1,
        lineEnd: end,
      });
      start = end;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const tooLong = (i - start) >= MAX_SEGMENT_LINES;
    const isBoundary = i > start && boundaryRegex.test(lines[i]);

    if (isBoundary || tooLong) {
      if (tooLong && !isBoundary) {
        // try to find a nearby blank line to split at cleanly
        let splitAt = i;
        for (let j = i; j > start + MAX_SEGMENT_LINES * 0.6; j--) {
          if (lines[j].trim() === '') { splitAt = j; break; }
        }
        flush(splitAt);
      } else {
        flush(i);
      }
    }
  }

  flush(lines.length);
  return segments;
}

async function run(payload) {
  const { code = '' } = payload;
  try {
    const parsed = splitByLogicalBoundaries(code);
    const summary = `Parsed into ${parsed.length} segment(s)`;
    return { agent: 'parser', status: 'pass', parsed, findings: [], summary };
  } catch (err) {
    return {
      agent: 'parser',
      status: 'fail',
      parsed: [],
      findings: [],
      summary: `Parser error: ${err.message}`,
    };
  }
}

module.exports = { run };