const vscode = require('vscode');
const http   = require('http');
const { AgentStatusPanel } = require('./panels/agentStatus');
const { FindingsPanel }    = require('./panels/findings');
const { VerdictPanel }     = require('./panels/verdict');
const { SkepticChartsPanel } = require('./panels/skepticCharts');

/** @type {object|null} */
let lastResult = null;

function postReview(code, filePath, backendUrl) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ code, filePath });
    const url  = new URL('/review', backendUrl);
    const options = {
      hostname: url.hostname,
      port: url.port || 3001,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from backend')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  AgentStatusPanel.register(context);
  VerdictPanel.register(context);

  const cfg = () => vscode.workspace.getConfiguration('codeReview');

  // Review current file
  context.subscriptions.push(
    vscode.commands.registerCommand('codeReview.reviewFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return vscode.window.showWarningMessage('No active editor found.');
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Running code review agents…', cancellable: false },
        async () => {
          try {
            lastResult = await postReview(editor.document.getText(), editor.document.fileName, cfg().get('backendUrl'));
            AgentStatusPanel.refresh(context, lastResult);
            FindingsPanel.refresh(context, lastResult);
            VerdictPanel.refresh(context, lastResult);
          } catch (err) { vscode.window.showErrorMessage(`Review failed: ${err.message}`); }
        }
      );
    })
  );

  // Review selection
  context.subscriptions.push(
    vscode.commands.registerCommand('codeReview.reviewSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) return vscode.window.showWarningMessage('No text selected.');
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Reviewing selection…', cancellable: false },
        async () => {
          try {
            lastResult = await postReview(editor.document.getText(editor.selection), editor.document.fileName, cfg().get('backendUrl'));
            FindingsPanel.refresh(context, lastResult);
            VerdictPanel.refresh(context, lastResult);
          } catch (err) { vscode.window.showErrorMessage(`Review failed: ${err.message}`); }
        }
      );
    })
  );

  // Show findings webview
  context.subscriptions.push(
    vscode.commands.registerCommand('codeReview.showFindings', () => FindingsPanel.show(context, lastResult))
  );

  // Show skeptic charts webview
  context.subscriptions.push(
    vscode.commands.registerCommand('codeReview.showCharts', () => SkepticChartsPanel.show(context, lastResult))
  );

  // Auto-review on save
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      if (!cfg().get('autoReviewOnSave')) return;
      try {
        lastResult = await postReview(document.getText(), document.fileName, cfg().get('backendUrl'));
        FindingsPanel.refresh(context, lastResult);
        VerdictPanel.refresh(context, lastResult);
      } catch { /* silent */ }
    })
  );

  vscode.window.showInformationMessage('Multi-Agent Code Review is active.');
}

function deactivate() {}

module.exports = { activate, deactivate };
