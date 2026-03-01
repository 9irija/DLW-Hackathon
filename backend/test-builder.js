/**
 * Test script for Builder agent.
 * Run from backend: node test-builder.js
 * Requires OPENAI_API_KEY in .env for full API test.
 */

require('dotenv').config();
const builder = require('./agents/builder');

const hasKey = !!process.env.OPENAI_API_KEY;

const testCode = `
const express = require('express');
const db = require('./db');

// Login handler: validates user and sets session cookie
async function loginUser(req, res) {
  const { username, password } = req.body;
  const user = await db.query('SELECT * FROM users WHERE username = "' + username + '"');
  if (!user) return res.status(401).send('Unauthorized');
  const match = await require('bcrypt').compare(password, user.password_hash);
  if (match) {
    res.cookie('session', user.id, { httpOnly: false });
    res.redirect('/dashboard');
  } else {
    res.status(401).send('Unauthorized');
  }
}

module.exports = { loginUser };
`;

async function run() {
  console.log('=== Builder run(payload) ===\n');
  const payload = {
    code: testCode,
    filePath: 'src/auth/login.js',
    language: 'javascript',
  };

  const result = await builder.run(payload);
  console.log('Agent:', result.agent);
  console.log('Status:', result.status);
  console.log('Summary:', result.summary);
  console.log('Findings count:', result.findings?.length ?? 0);
  if (result.findings?.length) {
    result.findings.forEach((f, i) => {
      console.log(`  [${i + 1}]`, f.severity, '-', f.description?.slice(0, 60) + (f.description?.length > 60 ? '…' : ''));
    });
  }
  if (result.codeContext) {
    console.log('\n--- CodeContext (excerpt) ---');
    const ctx = result.codeContext;
    console.log('Intent:', ctx.intent?.slice(0, 100) + (ctx.intent?.length > 100 ? '…' : ''));
    console.log('Entry points:', ctx.entryPoints?.length ?? 0, ctx.entryPoints?.slice(0, 3));
    console.log('Dependencies:', ctx.dependencies?.length ?? 0, ctx.dependencies?.slice(0, 5));
    console.log('Potential risks:', ctx.potentialRisks?.length ?? 0);
  }

  console.log('\n=== respondToChallenge (simulated Attacker finding) ===\n');
  if (result.codeContext) {
    const challengeResponse = await builder.respondToChallenge(result.codeContext, {
      agentName: 'Attacker',
      finding: 'SQL injection: username is concatenated into raw SQL without parameterisation.',
      severity: 'CRITICAL',
    });
    console.log('Challenge response:', JSON.stringify(challengeResponse, null, 2).slice(0, 500) + '…');
  }

  console.log('\n=== Builder test completed ===');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
