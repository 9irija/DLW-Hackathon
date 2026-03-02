const fs = require('fs');
const pdfParse = require('pdf-parse');
(async () => {
  const buf = fs.readFileSync('guidelines.pdf');
  try {
    const r = await pdfParse(buf);
    const txt = r.text;
    const ruleRegex = /(?:FR-\d+|\b(?:must|should|shall|required|need to|ensure)\b)/i;
    const lines = txt.split('\n');
    const rules = lines.filter(l => ruleRegex.test(l));
    console.log('rules found count', rules.length);
    console.log('rules snippet:', rules.slice(0, 20).join('\n'));
  } catch (e) {
    console.error('pdf parse error', e.message);
  }
})();
