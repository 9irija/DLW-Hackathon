const fs = require('fs');
const path = require('path');
const fc = require('./agents/factchecker');
const docreader = require('./agents/docreader');

// load actual implementation from testcasefile.py
const code = fs.readFileSync(path.join(__dirname, 'testcasefile.py'), 'utf8');
const buf = fs.readFileSync(path.join(__dirname, 'guidelines.pdf'));
const doc = { name: 'guidelines.pdf', content: buf.toString('base64') };

(async () => {
  // show what the docreader extracts for visibility
  try {
    const dr = await docreader.run({ docs: [doc] });
    console.log('docreader output:', JSON.stringify(dr, null, 2));
  } catch (err) {
    console.error('docreader error:', err);
  }

  // now run factchecker with the same document
  try {
    const res = await fc.run({
      code,
      filePath: 'example.py',
      language: 'python',
      docs: [doc],
    });
    console.log('factchecker result:', JSON.stringify(res, null, 2));
    // print a brief summary of any rule-based findings we extracted
    const ruleFindings = res.findings.filter(f => f.docSource && f.severity === 'low');
    if (ruleFindings.length) {
      console.log(`rule findings count: ${ruleFindings.length}`);
      ruleFindings.forEach(f => console.log('  -', f.claim));
    }
  } catch (e) {
    console.error('factchecker error:', e);
  }
})();
