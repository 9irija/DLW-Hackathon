'use strict';

const vscode = require('vscode');
const http = require('http');
const https = require('https');
const { AgentStatusPanel } = require('./panels/agentStatus');
const { FindingsPanel } = require('./panels/findings');
const { VerdictPanel } = require('./panels/verdict');
const { SkepticChartsPanel } = require('./panels/skepticCharts');
const { HumanReviewPanel } = require('./panels/humanReview');

/** @type {object|null} */
let lastResult = null;

function postJson(pathname, payload, backendUrl) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload || {});
    const url = new URL(pathname, backendUrl);
    const lib = url.protocol === 'https:' ? https : http;

    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 3001),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      res => {
        let data = '';
        res.on('data', chunk => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data || '{}');
            if (parsed.error) {
              reject(new Error(parsed.error));
            } else {
              resolve(parsed);
            }
          } catch {
            reject(new Error('Invalid JSON from backend'));
          }
        });
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function refreshAllPanels(context, result, options = {}) {
  const openWebviews = options.openWebviews !== false;
  lastResult = result;
  if (openWebviews) {
    FindingsPanel.show(context, lastResult);
    SkepticChartsPanel.show(context, lastResult);
  } else {
    FindingsPanel.refresh(context, lastResult);
    SkepticChartsPanel.refresh(context, lastResult);
  }
  AgentStatusPanel.refresh(context, lastResult);
  VerdictPanel.refresh(context, lastResult);
}

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

function sortBySeverity(findings) {
  return [...(findings || [])].sort((a, b) => {
    const sev = (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0);
    if (sev !== 0) return sev;
    return (a.line || 0) - (b.line || 0);
  });
}

function extractSnippet(code, line, context = 3) {
  if (!line || typeof line !== 'number') return '';
  const lines = String(code || '').split('\n');
  const start = Math.max(0, line - 1 - context);
  const end = Math.min(lines.length, line - 1 + context + 1);
  return lines
    .slice(start, end)
    .map((text, i) => `${start + i + 1}: ${text}`)
    .join('\n');
}

function buildFactcheckerFindings(agentResult, filePath, code) {
  return sortBySeverity(
    (agentResult?.findings || []).map(f => ({
      ...f,
      filePath: f.filePath || filePath,
      codeSnippet: f.codeSnippet || extractSnippet(code, f.line),
    }))
  );
}

function buildAttackerFindings(agentResult, filePath, code) {
  return sortBySeverity(
    (agentResult?.findings || []).map(f => ({
      ...f,
      filePath: f.filePath || filePath,
      codeSnippet: extractSnippet(code, f.line),
    }))
  );
}

async function runSteppedReview(context, { code, filePath, language, workspaceRoot, docs, backendUrl }) {
  const start = await postJson(
    '/review/start',
    { code, filePath, language, workspaceRoot, docs },
    backendUrl
  );

  if (start.partialReview) refreshAllPanels(context, start.partialReview, { openWebviews: false });

  const factResult = await postJson('/review/next', { sessionId: start.sessionId, agent: 'factchecker' }, backendUrl);
  if (factResult.partialReview) refreshAllPanels(context, factResult.partialReview, { openWebviews: false });

  const factDecision = await HumanReviewPanel.prompt(
    context,
    {
      mode: 'checkpoint-factchecker',
      title: 'Factchecker Checkpoint',
      status: factResult.agentResult?.status || factResult.agentSummary?.status || 'unknown',
      summary: factResult.agentResult?.summary || '',
      findings: buildFactcheckerFindings(factResult.agentResult, filePath, code),
    },
    'stop'
  );

  if (factDecision !== 'approve') {
    const finalEarly = await postJson('/review/finalize', { sessionId: start.sessionId, testingMode: 'user' }, backendUrl);
    refreshAllPanels(context, finalEarly);
    HumanReviewPanel.show(context, {
      mode: 'final',
      title: 'Final Human Review',
      final: finalEarly,
      testingMode: 'user',
    });
    return finalEarly;
  }

  const attackerResult = await postJson('/review/next', { sessionId: start.sessionId, agent: 'attacker' }, backendUrl);
  if (attackerResult.partialReview) refreshAllPanels(context, attackerResult.partialReview, { openWebviews: false });

  const attackerDecision = await HumanReviewPanel.prompt(
    context,
    {
      mode: 'checkpoint-attacker',
      title: 'Attacker Checkpoint',
      status: attackerResult.agentResult?.status || attackerResult.agentSummary?.status || 'unknown',
      summary: attackerResult.agentResult?.summary || '',
      findings: buildAttackerFindings(attackerResult.agentResult, filePath, code),
    },
    'stop'
  );

  if (attackerDecision !== 'approve') {
    const finalEarly = await postJson('/review/finalize', { sessionId: start.sessionId, testingMode: 'user' }, backendUrl);
    refreshAllPanels(context, finalEarly);
    HumanReviewPanel.show(context, {
      mode: 'final',
      title: 'Final Human Review',
      final: finalEarly,
      testingMode: 'user',
    });
    return finalEarly;
  }

  const testingChoice = await HumanReviewPanel.prompt(
    context,
    {
      mode: 'skeptic-choice',
      title: 'Skeptic Test Choice',
    },
    'own_tests'
  );

  let testingMode = 'user';
  if (testingChoice === 'run_skeptic') {
    const skepticResult = await postJson('/review/next', { sessionId: start.sessionId, agent: 'skeptic' }, backendUrl);
    if (skepticResult.partialReview) refreshAllPanels(context, skepticResult.partialReview, { openWebviews: false });
    testingMode = 'skeptic';
  }

  const finalResult = await postJson('/review/finalize', { sessionId: start.sessionId, testingMode }, backendUrl);
  refreshAllPanels(context, finalResult);
  HumanReviewPanel.show(context, {
    mode: 'final',
    title: 'Final Human Review',
    final: finalResult,
    testingMode,
  });
  return finalResult;
}

async function runReview(context, code, filePath, language, silent = false, docs = []) {
  const cfg = vscode.workspace.getConfiguration('codeReview');
  const backendUrl = cfg.get('backendUrl') || 'http://127.0.0.1:3001';
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const basePayload = { code, filePath, language, workspaceRoot, docs };

  if (silent) {
    const singleShot = await postJson('/review', basePayload, backendUrl);
    refreshAllPanels(context, singleShot);
    return;
  }

  const result = await runSteppedReview(context, { ...basePayload, backendUrl });
  const icon = { approve: 'OK', 'request-changes': 'WARN', block: 'BLOCK' }[result?.verdict] ?? 'UNKNOWN';
  vscode.window.showInformationMessage(
    `${icon} Code review complete: ${(result?.verdict ?? 'unknown').toUpperCase()} - Score ${result?.score ?? '-'} / 100`
  );
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  AgentStatusPanel.register(context);
  VerdictPanel.register(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('codeReview.reviewFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return vscode.window.showWarningMessage('No active editor found.');

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Running stepped code review...', cancellable: false },
        async () => {
          try {
            await runReview(
              context,
              editor.document.getText(),
              editor.document.fileName,
              editor.document.languageId
            );
          } catch (err) {
            console.error('[CodeReview] reviewFile error:', err);
            vscode.window.showErrorMessage(`Review failed: ${err.message || String(err)}`);
          }
        }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeReview.reviewSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        return vscode.window.showWarningMessage('Select some code first.');
      }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Reviewing selection...', cancellable: false },
        async () => {
          try {
            await runReview(
              context,
              editor.document.getText(editor.selection),
              editor.document.fileName,
              editor.document.languageId
            );
          } catch (err) {
            vscode.window.showErrorMessage(`Review failed: ${err.message}`);
          }
        }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeReview.reviewWithDocs', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return vscode.window.showWarningMessage('No active editor found.');

      const uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Select documentation file(s)',
        filters: { Documents: ['md', 'txt', 'rst', 'adoc', 'html'] },
      });
      if (!uris || !uris.length) return;

      const fs = require('fs');
      const path = require('path');
      const docs = uris
        .map(uri => ({
          name: path.basename(uri.fsPath),
          content: (() => {
            try {
              return fs.readFileSync(uri.fsPath, 'utf8');
            } catch {
              return '';
            }
          })(),
        }))
        .filter(d => d.content);

      if (!docs.length) {
        return vscode.window.showWarningMessage('Could not read selected document(s).');
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Reviewing with ${docs.length} doc(s)...`,
          cancellable: false,
        },
        async () => {
          try {
            await runReview(
              context,
              editor.document.getText(),
              editor.document.fileName,
              editor.document.languageId,
              false,
              docs
            );
          } catch (err) {
            vscode.window.showErrorMessage(`Review failed: ${err.message}`);
          }
        }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeReview.showFindings', () => FindingsPanel.show(context, lastResult))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codeReview.showCharts', () => SkepticChartsPanel.show(context, lastResult))
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async document => {
      const cfg = vscode.workspace.getConfiguration('codeReview');
      if (!cfg.get('autoReviewOnSave')) return;
      try {
        await runReview(context, document.getText(), document.fileName, document.languageId, true);
      } catch {
        // silent by design
      }
    })
  );

  vscode.commands.executeCommand('codeReview.agentStatus.focus').then(
    () => {},
    () => {}
  );

  vscode.window.showInformationMessage(
    'Code Review is active. Use Code Review commands to run stepped checkpoints, and configure codeReview.backendUrl if needed.'
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
