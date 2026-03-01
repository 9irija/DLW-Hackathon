/**
 * factchecker — verifies that comments, docstrings, and inline docs
 * accurately describe what the code actually does.
 *
 * Output shape:
 * {
 *   agent: "factchecker",
 *   status: "pass" | "warn" | "fail",
 *   findings: [{ line, claim, reality, severity, suggestion }],
 *   summary: string
 * }
 */

const openai = require('../core/openai');

const SYSTEM_PROMPT = `You are a fact-checker for source code. Your job is to compare every comment, docstring, JSDoc, and inline documentation in the code with what the code actually does.

For each mismatch you find, output one finding with:
- line: approximate line number (number) where the comment/docs appear
- claim: what the comment/documentation says
- reality: what the code actually does (brief)
- severity: "low" | "medium" | "high"
- suggestion: how to fix the comment or the code (one short sentence)

If there are no mismatches, return an empty findings array.

Respond with valid JSON only, in this exact shape (no markdown, no extra text):
{"findings": [{"line": number, "claim": string, "reality": string, "severity": string, "suggestion": string}], "summary": string}
The summary should be one sentence: either "All comments match the implementation." or a brief overview of what you found.`;

/**
 * @param {object} payload
 * @param {string}   payload.code
 * @param {string}   payload.filePath
 * @param {string}   payload.language
 * @param {string}   [payload.diff]
 * @param {object[]} [payload.context]
 * @returns {Promise<object>}
 */
async function run(payload) {
  const { code, filePath, language } = payload;

  const userContent = `File: ${filePath}\nLanguage: ${language}\n\nCode:\n\`\`\`\n${code}\n\`\`\`\n\nList every place where a comment or docstring does not match the implementation. Output JSON only.`;

  let findings = [];
  let summary = 'Fact-check could not be completed.';

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      temperature: 0.2,
      max_tokens: 2048,
    });

    const raw = completion.choices?.[0]?.message?.content?.trim();
    if (!raw) {
      return {
        agent: 'factchecker',
        status: 'warn',
        findings: [],
        summary: 'No response from fact-check model.',
      };
    }

    const cleaned = raw.replace(/^```json\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);

    if (Array.isArray(parsed.findings)) {
      findings = parsed.findings.map((f) => ({
        line: typeof f.line === 'number' ? f.line : undefined,
        claim: String(f.claim ?? ''),
        reality: String(f.reality ?? ''),
        severity: ['low', 'medium', 'high'].includes(String(f.severity).toLowerCase())
          ? String(f.severity).toLowerCase()
          : 'medium',
        suggestion: String(f.suggestion ?? ''),
      }));
    }
    if (typeof parsed.summary === 'string') summary = parsed.summary;
  } catch (err) {
    console.error('Factchecker OpenAI error:', err.message);
    return {
      agent: 'factchecker',
      status: 'warn',
      findings: [],
      summary: `Fact-check error: ${err.message}`,
    };
  }

  const hasHigh = findings.some((f) => f.severity === 'high');
  const hasMedium = findings.some((f) => f.severity === 'medium');
  const status = hasHigh ? 'fail' : hasMedium ? 'warn' : findings.length > 0 ? 'warn' : 'pass';

  return {
    agent: 'factchecker',
    status,
    findings,
    summary,
  };
}

module.exports = { run };
