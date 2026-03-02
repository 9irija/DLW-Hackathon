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

  // also test external documentation pass
  payload.docs = [{ name: 'spec.md', content: `# Title
This code adds numbers (but the implementation subtracts).` }];
  let result = await run(payload);

  console.log('Agent:', result.agent);
  console.log('Status:', result.status);
  console.log('Summary:', result.summary);
  console.log('Findings:', result.findings?.length ?? 0);
  result.findings.forEach(f => {
    if (f.docSource) {
      console.log(`    [doc:${f.docSource}${f.docSection ? ' section '+f.docSection : ''}${f.docPage!=null ? ' page '+f.docPage : ''}] ${f.claim} -> ${f.reality}`);
    }
  });
  if (result.findings?.length) {
    result.findings.forEach((f, i) => {
      console.log(`  ${i + 1}. Line ${f.line}: "${f.claim}" → reality: ${f.reality} [${f.severity}]`);
      console.log(`     Suggestion: ${f.suggestion}`);
    });
  }

  // second test: large Python file if present
  try {
    const fs = require('fs');
    const path = require('path');
    const largePath = path.resolve(__dirname, 'testcasefile.py');
    if (fs.existsSync(largePath)) {
      console.log('\nRunning factchecker on testcasefile.py to reproduce parsing issues...\n');
      const code = fs.readFileSync(largePath, 'utf8');
      const payload2 = buildReviewPayload(code, 'testcasefile.py');
      result = await run(payload2);
      console.log('Large file agent status:', result.status, 'findings:', result.findings.length);
    }
  } catch (e) {
    console.warn('Large-file test failed:', e.message);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
