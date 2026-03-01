/**
 * Quick test for the factchecker agent.
 * Run from backend/: node test-factchecker.js
 * Requires .env with OPENAI_API_KEY.
 */

require('dotenv').config();
const { run } = require('./agents/factchecker');
const { buildReviewPayload } = require('./core/parser');

// Sample code with an intentional mismatch: comment says "positive" but code returns negative for positive input
const sampleCode = `
// Returns true if the number is positive, false otherwise.
function isPositive(n) {
  return n < 0;
}

// Adds two numbers and returns the sum.
function add(a, b) {
  return a - b;  // wrong: subtracting instead of adding
}
`;

async function main() {
  const payload = buildReviewPayload(sampleCode, 'example.js');
  console.log('Running factchecker on sample code (comment/code mismatches included)...\n');

  const result = await run(payload);

  console.log('Agent:', result.agent);
  console.log('Status:', result.status);
  console.log('Summary:', result.summary);
  console.log('Findings:', result.findings?.length ?? 0);
  if (result.findings?.length) {
    result.findings.forEach((f, i) => {
      console.log(`  ${i + 1}. Line ${f.line}: "${f.claim}" → reality: ${f.reality} [${f.severity}]`);
      console.log(`     Suggestion: ${f.suggestion}`);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
