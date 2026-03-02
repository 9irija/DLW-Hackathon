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

function splitByLogicalBoundaries(code) {
  const lines = String(code || '').split('\n');
  const segments = [];
  let start = 0;

  const boundaryRegex = /^(?:\s*(?:function|class|async function|export\b))/;

  for (let i = 0; i < lines.length; i++) {
    if (i > start && boundaryRegex.test(lines[i])) {
      segments.push({
        snippet: lines.slice(start, i).join('\n'),
        lineStart: start + 1,
        lineEnd: i,
      });
      start = i;
    }
  }

  if (start < lines.length) {
    segments.push({
      snippet: lines.slice(start).join('\n'),
      lineStart: start + 1,
      lineEnd: lines.length,
    });
  }

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