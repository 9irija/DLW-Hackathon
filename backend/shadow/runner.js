/**
 * Safely executes small code snippets in an isolated child process
 * to catch obvious crashes or validate that a suggested fix runs cleanly.
 */

const { execFile } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const crypto = require('crypto');

const TIMEOUT_MS = 5000;

/**
 * Write snippet to a temp file and run it, returning captured output.
 *
 * @param {string} code      source code to execute
 * @param {string} language  currently only "javascript" is supported
 * @returns {Promise<{executed, stdout, stderr, exitCode, timedOut, durationMs}>}
 */
async function runSnippet(code, language = 'javascript') {
  if (language !== 'javascript') {
    return { executed: false, stdout: '', stderr: `Language not supported: ${language}`, exitCode: -1, timedOut: false, durationMs: 0 };
  }

  const tmpFile = path.join(os.tmpdir(), `shadow_${crypto.randomBytes(6).toString('hex')}.js`);
  fs.writeFileSync(tmpFile, code, 'utf8');

  const start = Date.now();
  return new Promise((resolve) => {
    execFile('node', [tmpFile], { timeout: TIMEOUT_MS }, (error, stdout, stderr) => {
      fs.unlink(tmpFile, () => {}); // best-effort cleanup
      resolve({
        executed:   true,
        stdout:     stdout || '',
        stderr:     stderr || (error && !error.killed ? error.message : ''),
        exitCode:   error ? (error.code ?? 1) : 0,
        timedOut:   error?.killed ?? false,
        durationMs: Date.now() - start,
      });
    });
  });
}

module.exports = { runSnippet };
