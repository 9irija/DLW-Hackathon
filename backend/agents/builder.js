/**
 * builder — constructive agent that suggests improvements: performance,
 * better patterns, refactoring opportunities, and missing test coverage.
 *
 * Output shape:
 * {
 *   agent: "builder",
 *   status: "pass" | "warn" | "fail",
 *   findings: [{ line, category, description, severity, suggestion, example }],
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
  // TODO: implement constructive improvement suggestions
  return {
    agent: 'builder',
    status: 'pass',
    findings: [],
    summary: 'Builder agent not yet implemented.',
  };
}

module.exports = { run };
