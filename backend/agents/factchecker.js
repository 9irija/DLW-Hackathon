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
  // TODO: implement fact-checking logic
  return {
    agent: 'factchecker',
    status: 'pass',
    findings: [],
    summary: 'Fact-checker not yet implemented.',
  };
}

module.exports = { run };
