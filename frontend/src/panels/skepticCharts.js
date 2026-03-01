const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');

/** @type {vscode.WebviewPanel|null} */
let panel = null;

const SkepticChartsPanel = {
  show(context, result) {
    if (panel) { panel.reveal(vscode.ViewColumn.Two); }
    else {
      panel = vscode.window.createWebviewPanel(
        'codeReview.charts', 'Code Review — Skeptic Charts',
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
  const htmlPath = path.join(context.extensionPath, 'src', 'webviews', 'charts.html');
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
  <title>Skeptic Charts</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
    canvas { max-width: 600px; margin: 0 auto; display: block; }
  </style>
</head>
<body>
  <h2>Skeptic — Confidence Scores</h2>
  <canvas id="chart"></canvas>
  <script>
    /*INJECT_DATA*/
    const findings = reviewData?.agentResults?.skeptic?.findings || [];
    new Chart(document.getElementById('chart'), {
      type: 'bar',
      data: {
        labels: findings.map((f, i) => f.category ? \`\${f.category} #\${i+1}\` : \`Finding \${i+1}\`),
        datasets: [{ label: 'Confidence', data: findings.map(f => f.confidence ?? 0),
          backgroundColor: 'rgba(99,179,237,0.6)', borderColor: 'rgba(99,179,237,1)', borderWidth: 1 }],
      },
      options: {
        scales: {
          y: { beginAtZero: true, max: 100, ticks: { color: '#ccc' }, grid: { color: '#333' } },
          x: { ticks: { color: '#ccc' }, grid: { color: '#333' } },
        },
        plugins: { legend: { labels: { color: '#ccc' } } },
      },
    });
  </script>
</body>
</html>`;
}

module.exports = { SkepticChartsPanel };
