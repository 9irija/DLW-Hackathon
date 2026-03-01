const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');

/** @type {vscode.WebviewPanel|null} */
let panel = null;

const FindingsPanel = {
  show(context, result) {
    if (panel) { panel.reveal(vscode.ViewColumn.Two); }
    else {
      panel = vscode.window.createWebviewPanel(
        'codeReview.findings', 'Code Review — Findings',
        vscode.ViewColumn.Two,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      panel.onDidDispose(() => { panel = null; });
    }
    panel.webview.html = buildHtml(context, result);
  },

  refresh(context, result) { if (panel) panel.webview.html = buildHtml(context, result); },
};

function buildHtml(context, result) {
  const htmlPath = path.join(context.extensionPath, 'src', 'webviews', 'findings.html');
  let template = '';
  try { template = fs.readFileSync(htmlPath, 'utf8'); }
  catch { template = defaultTemplate(); }
  return template.replace('/*INJECT_DATA*/', `const reviewData = ${JSON.stringify(result ?? {})};`);
}

function defaultTemplate() {
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Findings</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
    th { background: var(--vscode-editor-lineHighlightBackground); }
    .high { color: #f48771; } .medium { color: #cca700; } .low { color: #89d185; }
  </style>
</head>
<body>
  <h2>Findings</h2>
  <div id="root">Loading…</div>
  <script>
    /*INJECT_DATA*/
    const root = document.getElementById('root');
    const findings = reviewData.prioritizedFindings || [];
    if (!findings.length) {
      root.textContent = 'No findings — run a review first.';
    } else {
      const rows = findings.map(f =>
        \`<tr><td>\${f.source||''}</td><td>\${f.line||'—'}</td>
          <td class="\${f.severity||''}">\${f.severity||''}</td>
          <td>\${f.description||f.claim||''}</td><td>\${f.suggestion||''}</td></tr>\`
      ).join('');
      root.innerHTML = \`<table>
        <thead><tr><th>Agent</th><th>Line</th><th>Severity</th><th>Issue</th><th>Suggestion</th></tr></thead>
        <tbody>\${rows}</tbody></table>\`;
    }
  </script>
</body>
</html>`;
}

module.exports = { FindingsPanel };
