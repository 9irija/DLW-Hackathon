'use strict';

const vscode = require('vscode');
const http   = require('http');
const https  = require('https');
const { AgentStatusPanel }   = require('./panels/agentStatus');
const { FindingsPanel }      = require('./panels/findings');
const { VerdictPanel }       = require('./panels/verdict');
const { SkepticChartsPanel } = require('./panels/skepticCharts');

/** @type {object|null} */
let lastResult = null;

// ─── Backend call ─────────────────────────────────────────────────────────────

/**
 * POST to the backend /review endpoint.
 * Sends code + file metadata the orchestrator needs.
 *
 * @param {object} opts
 * @param {string}  opts.code
 * @param {string}  opts.filePath
 * @param {string}  opts.language        — VS Code languageId (js, python, etc.)
 * @param {string}  [opts.workspaceRoot] — workspace root for skeptic test runner
 * @param {string}  opts.backendUrl
 * @returns {Promise<object>}            — orchestrator result
 */
function postReview({ code, filePath, language, workspaceRoot, docs, backendUrl }) {
  return new Promise((resolve, reject) => {
    const body    = JSON.stringify({ code, filePath, language, workspaceRoot, docs });
    const url     = new URL('/review', backendUrl);
    const lib     = url.protocol === 'https:' ? https : http;
    const options = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 3001),
      path:     url.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // Surface HTTP-level errors (400, 500) as thrown errors
          if (parsed.error) reject(new Error(parsed.error));
          else              resolve(parsed);
        } catch {
          reject(new Error('Invalid JSON from backend'));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Shared review handler ────────────────────────────────────────────────────

/**
 * Run a review, update all panels, and show a verdict notification.
 * Called by all review triggers (file, selection, with-docs, auto-save).
 * @param {Array} [docs]  — [{ name, content }] for factchecker doc pass
 */
async function runReview(context, code, filePath, language, silent = false, docs = []) {
  const cfg           = vscode.workspace.getConfiguration('codeReview');
  const backendUrl    = cfg.get('backendUrl') || 'http://127.0.0.1:3001';
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  lastResult = await postReview({ code, filePath, language, workspaceRoot, docs, backendUrl });

  // Open / refresh both webview panels so they always show current results
  FindingsPanel.show(context, lastResult);
  SkepticChartsPanel.show(context, lastResult);

  // Update sidebar tree providers
  AgentStatusPanel.refresh(context, lastResult);
  VerdictPanel.refresh(context, lastResult);

  // Verdict notification (skip on silent auto-save)
  if (!silent) {
    const { verdict, score } = lastResult;
    const icon = { approve: '✅', 'request-changes': '⚠️', block: '🚫' }[verdict] ?? '❓';
    vscode.window.showInformationMessage(
      `${icon} Code review complete: ${(verdict ?? 'unknown').toUpperCase()} — Score ${score ?? '—'}/100`
    );
  }
}

// ─── Extension activation ─────────────────────────────────────────────────────

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  // Register sidebar tree providers on startup
  AgentStatusPanel.register(context);
  VerdictPanel.register(context);

  // ── Review current file ──────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('codeReview.reviewFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return vscode.window.showWarningMessage('No active editor found.');

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Running code review agents…', cancellable: false },
        async () => {
          try {
            await runReview(
              context,
              editor.document.getText(),
              editor.document.fileName,
              editor.document.languageId,
            );
          } catch (err) {
            console.error('[CodeReview] reviewFile error:', err);
            vscode.window.showErrorMessage(`Review failed: ${err.message || String(err)}`);
          }
        }
      );
    })
  );

  // ── Review selection ─────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('codeReview.reviewSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        return vscode.window.showWarningMessage('Select some code first.');
      }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Reviewing selection…', cancellable: false },
        async () => {
          try {
            await runReview(
              context,
              editor.document.getText(editor.selection),
              editor.document.fileName,
              editor.document.languageId,
            );
          } catch (err) {
            vscode.window.showErrorMessage(`Review failed: ${err.message}`);
          }
        }
      );
    })
  );

  // ── Review file + external docs ──────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('codeReview.reviewWithDocs', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return vscode.window.showWarningMessage('No active editor found.');

      // Let user pick one or more documentation files
      const uris = await vscode.window.showOpenDialog({
        canSelectMany:    true,
        openLabel:        'Select documentation file(s)',
        filters:          { 'Documents': ['md','txt','rst','adoc','html'] },
      });
      if (!uris || !uris.length) return; // cancelled

      // Read each selected file as text
      const fs   = require('fs');
      const path = require('path');
      const docs = uris.map(uri => ({
        name:    path.basename(uri.fsPath),
        content: (() => { try { return fs.readFileSync(uri.fsPath, 'utf8'); } catch { return ''; } })(),
      })).filter(d => d.content);

      if (!docs.length) {
        return vscode.window.showWarningMessage('Could not read selected document(s).');
      }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Reviewing with ${docs.length} doc(s)…`, cancellable: false },
        async () => {
          try {
            await runReview(
              context,
              editor.document.getText(),
              editor.document.fileName,
              editor.document.languageId,
              false,
              docs,
            );
          } catch (err) {
            vscode.window.showErrorMessage(`Review failed: ${err.message}`);
          }
        }
      );
    })
  );

  // ── Show findings (open panel, populate with last result) ────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('codeReview.showFindings', () =>
      FindingsPanel.show(context, lastResult)
    )
  );

  // ── Show charts (open panel, populate with last result) ──────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('codeReview.showCharts', () =>
      SkepticChartsPanel.show(context, lastResult)
    )
  );

  // ── Auto-review on save ──────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      const cfg = vscode.workspace.getConfiguration('codeReview');
      if (!cfg.get('autoReviewOnSave')) return;
      try {
        await runReview(
          context,
          document.getText(),
          document.fileName,
          document.languageId,
          true,  // silent — no notification toast on auto-save
        );
      } catch { /* silent */ }
    })
  );

  // Auto-open Code Review sidebar so the user can see it (focus first view in the container)
  vscode.commands.executeCommand('codeReview.agentStatus.focus').then(() => {}, () => {});

  vscode.window.showInformationMessage(
    'Code Review 已激活。左侧点击盾牌图标可查看结果；若后端在 3002/3003 等端口，请在设置中修改 codeReview.backendUrl'
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
