const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

/** @type {vscode.WebviewPanel|null} */
let panel = null;

function buildHtml(context, payload) {
  const htmlPath = path.join(context.extensionPath, 'src', 'webviews', 'humanReview.html');
  let template = '';
  try {
    template = fs.readFileSync(htmlPath, 'utf8');
  } catch {
    template = '<!doctype html><html><body><pre>humanReview.html missing</pre></body></html>';
  }
  return template.replace('/*INJECT_DATA*/', `const reviewData = ${JSON.stringify(payload || {})};`);
}

function ensurePanel(context, title) {
  if (panel) {
    panel.title = title;
    panel.reveal(vscode.ViewColumn.Active);
    return panel;
  }

  panel = vscode.window.createWebviewPanel(
    'codeReview.humanReview',
    title,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.onDidDispose(() => {
    panel = null;
  });
  return panel;
}

async function prompt(context, payload, fallbackDecision = 'stop') {
  return new Promise(resolve => {
    const p = ensurePanel(context, payload?.title || 'Human Verification');
    p.webview.html = buildHtml(context, payload);

    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      msgDisposable.dispose();
      closeDisposable.dispose();
      resolve(value);
    };

    const msgDisposable = p.webview.onDidReceiveMessage(msg => {
      if (!msg || msg.type !== 'decision') return;
      finish(msg.value || fallbackDecision);
    });

    const closeDisposable = p.onDidDispose(() => {
      finish(fallbackDecision);
    });
  });
}

function show(context, payload) {
  const p = ensurePanel(context, payload?.title || 'Human Verification');
  p.webview.html = buildHtml(context, payload);
}

const HumanReviewPanel = { prompt, show };

module.exports = { HumanReviewPanel };
