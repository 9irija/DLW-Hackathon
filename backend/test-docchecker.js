require('dotenv').config();
const fs = require('fs');
const path = require('path');
const docreader = require('./agents/docreader');

// Load actual implementation and doc: factchecker compares doc against this code
const code = fs.readFileSync(path.join(__dirname, 'testcasefile.py'), 'utf8');
const buf = fs.readFileSync(path.join(__dirname, 'guidelines.pdf'));
const doc = { name: 'guidelines.pdf', content: buf.toString('base64') };

(async () => {
  // 1) Docreader: ensure we can read the doc and get sections (used by factchecker for doc vs code)
  try {
    const dr = await docreader.run({ docs: [doc] });
    console.log('docreader output:', JSON.stringify(dr, null, 2));
    if (dr.docs && dr.docs[0] && dr.docs[0].sections && dr.docs[0].sections.length) {
      console.log('Doc readable: sections =', dr.docs[0].sections.length);
    }
    const extracted = await docreader.extractText(doc);
    console.log('Doc plain text length:', typeof extracted === 'string' ? extracted.length : 0);
  } catch (err) {
    console.error('docreader error:', err);
    process.exit(1);
  }

  if (!process.env.OPENAI_API_KEY) {
    console.log('\nOPENAI_API_KEY not set. Docreader passed. Run with API key to test full factchecker (doc vs code).');
    return;
  }

  // 2) Factchecker: compare doc against code (inline comments + external doc)
  const fc = require('./agents/factchecker');
  try {
    const res = await fc.run({
      code,
      filePath: 'example.py',
      language: 'python',
      docs: [doc],
    });
    console.log('factchecker result:', JSON.stringify(res, null, 2));
    const ruleFindings = res.findings.filter(f => f.docSource && f.severity === 'low');
    if (ruleFindings.length) {
      console.log(`rule findings count: ${ruleFindings.length}`);
      ruleFindings.forEach(f => console.log('  -', f.claim));
    }
  } catch (e) {
    console.error('factchecker error:', e);
  }
})();
