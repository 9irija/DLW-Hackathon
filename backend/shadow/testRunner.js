/**
 * Runs the project test suite in an isolated subprocess.
 * Parses Jest-style or generic test output for pass/fail and timing.
 */

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const TIMEOUT_MS = 60000; // 1 min for full suite

/**
 * Run npm test (or npx jest) in workspace and capture output.
 * @param {string} workspaceRoot - absolute path to project root
 * @returns {Promise<{ ran: boolean, passed: number, failed: number, total: number, durationMs: number, tests: Array<{ name: string, outcome: 'pass'|'fail', durationMs?: number, error?: string }>, rawOutput: string, rawStderr: string }>}
 */
function runTestSuite(workspaceRoot) {
  return new Promise((resolve) => {
    if (!workspaceRoot || !fs.existsSync(path.join(workspaceRoot, 'package.json'))) {
      resolve({
        ran: false,
        passed: 0,
        failed: 0,
        total: 0,
        durationMs: 0,
        tests: [],
        rawOutput: '',
        rawStderr: 'No workspace or package.json',
      });
      return;
    }

    const start = Date.now();
    exec(
      'npm test 2>&1',
      { cwd: workspaceRoot, timeout: TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - start;
        const raw = (stdout || '') + (stderr || '');
        const parsed = parseTestOutput(raw);
        resolve({
          ran: true,
          passed: parsed.passed,
          failed: parsed.failed,
          total: parsed.total,
          durationMs,
          tests: parsed.tests,
          rawOutput: stdout || '',
          rawStderr: stderr || '',
        });
      }
    );
  });
}

/**
 * Parse Jest or similar test output for pass/fail and timing.
 * Handles: Jest default output, TAP-style, and "X tests, Y passed" lines.
 */
function parseTestOutput(raw) {
  const tests = [];
  let passed = 0;
  let failed = 0;

  // No test script or not a test run
  if (raw.includes('missing script: test') || raw.includes('npm ERR!')) {
    return { passed: 0, failed: 0, total: 0, tests: [] };
  }

  // Jest default: "✓ name" or "✕ name" / "PASS/FAIL path"
  const lines = raw.split(/\r?\n/);
  const failBlocks = [];
  let currentFail = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const passMatch = line.match(/^\s*[✓✔]|passed|PASS\s/);
    const failMatch = line.match(/^\s*[✕✖×]|failed|FAIL\s/);
    const testNameMatch = line.match(/\s*(?:✓|✕|✔|✖|×)\s+(.+)/) || line.match(/\s*●?\s*(.+?)(?:\s·\s|\s\d+ms|\s$)/);

    if (failMatch && testNameMatch) {
      failed += 1;
      currentFail = { name: testNameMatch[1].trim(), error: '' };
    } else if (passMatch && testNameMatch) {
      passed += 1;
      tests.push({ name: testNameMatch[1].trim(), outcome: 'pass', durationMs: undefined });
      currentFail = null;
    } else if (currentFail && (line.includes('Expected') || line.includes('Received') || line.includes('Error'))) {
      currentFail.error += line + '\n';
    } else if (currentFail && line.trim() && !line.startsWith('at ')) {
      currentFail.error += line + '\n';
    } else if (currentFail && (line.startsWith('    at ') || line.trim() === '')) {
      tests.push({ name: currentFail.name, outcome: 'fail', error: currentFail.error.trim() });
      currentFail = null;
    }
  }
  if (currentFail) tests.push({ name: currentFail.name, outcome: 'fail', error: currentFail.error.trim() });

  // Fallback: count "X passed, Y failed" or "Tests: X failed, Y total"
  if (tests.length === 0) {
    const sumMatch = raw.match(/(\d+)\s*passed|(\d+)\s*failed|Tests:\s*(\d+)\s*failed,\s*(\d+)\s*total/gi);
    if (sumMatch) {
      const lower = raw.toLowerCase();
      const passedM = lower.match(/(\d+)\s*passed/);
      const failedM = lower.match(/(\d+)\s*failed/);
      passed = passedM ? parseInt(passedM[1], 10) : 0;
      failed = failedM ? parseInt(failedM[1], 10) : 0;
    }
  } else {
    passed = tests.filter((t) => t.outcome === 'pass').length;
    failed = tests.filter((t) => t.outcome === 'fail').length;
  }

  const total = passed + failed;
  return { passed, failed, total, tests };
}

module.exports = { runTestSuite, parseTestOutput };
