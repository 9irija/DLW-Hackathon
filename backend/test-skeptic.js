/**
 * Test script for Skeptic agent (no OpenAI key required).
 * Run from backend: node test-skeptic.js
 */

const skeptic = require('./agents/skeptic');
const { runTestSuite } = require('./shadow/testRunner');
const { buildFlowFromCode } = require('./shadow/flowParser');

async function run() {
  console.log('=== 1. Skeptic with snippet only (no workspaceRoot) ===');
  const r1 = await skeptic.run({
    code: 'console.log(1 + 1);',
    filePath: 'math.js',
    language: 'javascript',
  });
  console.log('Status:', r1.status, '| Confidence:', r1.confidence);
  console.log('Findings:', r1.findings.length);
  console.log('Evidence:', r1.evidence ? 'yes' : 'no');
  if (r1.evidence) {
    console.log('  - failureTimeline:', r1.evidence.failureTimeline?.length);
    console.log('  - endpointHeatmap:', r1.evidence.endpointHeatmap?.length);
    console.log('  - latencyDistribution:', r1.evidence.latencyDistribution ? 'yes' : 'no');
  }
  console.log('Flow:', r1.flow ? `${r1.flow.nodes.length} nodes, ${r1.flow.edges.length} edges` : 'none');
  console.log('Summary:', r1.summary);
  console.log('');

  console.log('=== 2. Skeptic with code that has require() ===');
  const r2 = await skeptic.run({
    code: 'const express = require("express");\nconst db = require("./db");',
    filePath: 'server.js',
    language: 'javascript',
  });
  console.log('Flow:', r2.flow ? `${r2.flow.nodes.length} nodes, ${r2.flow.edges.length} edges` : 'none');
  if (r2.flow) {
    console.log('  Nodes:', r2.flow.nodes.map((n) => n.label).join(', '));
    console.log('  Edges:', r2.flow.edges.map((e) => e.from + '->' + e.to).join(', '));
  }
  console.log('');

  console.log('=== 3. Test runner (npm test in this project) ===');
  const suite = await runTestSuite(process.cwd());
  console.log('Ran:', suite.ran, '| Passed:', suite.passed, '| Failed:', suite.failed, '| Total:', suite.total);
  if (suite.tests.length > 0) {
    console.log('Sample tests:', suite.tests.slice(0, 3).map((t) => `${t.name} (${t.outcome})`).join('; '));
  } else {
    console.log('(No test script or no parsed tests)');
  }
  console.log('');

  console.log('=== 4. Skeptic with workspaceRoot (runs test suite) ===');
  const r3 = await skeptic.run({
    code: 'const x = 1;',
    filePath: 'index.js',
    language: 'javascript',
    workspaceRoot: process.cwd(),
  });
  console.log('Status:', r3.status, '| Confidence:', r3.confidence);
  console.log('Findings:', r3.findings.length);
  if (r3.evidence) {
    console.log('Evidence: timeline', r3.evidence.failureTimeline?.length, 'endpoints', r3.evidence.endpointHeatmap?.length);
  }
  console.log('Summary:', r3.summary);

  console.log('\n=== All Skeptic tests completed ===');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
