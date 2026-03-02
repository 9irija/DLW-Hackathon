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

/** @type {vscode.StatusBarItem|null} */
let statusBarItem = null;

/** Update status bar to reflect a finished review verdict. */
function setStatusBarResult(result) {
  if (!statusBarItem || !result) return;
  const icon  = { approve: '$(pass)', 'request-changes': '$(warning)', block: '$(error)' }[result.verdict] ?? '$(shield)';
  const label = { approve: 'APPROVE', 'request-changes': 'CHANGES', block: 'BLOCK' }[result.verdict] ?? 'DONE';
  statusBarItem.text    = `${icon} ${label} ${result.score ?? '—'}/100`;
  statusBarItem.tooltip = result.summary ?? 'Click to show findings';
}

// ─── Backend call ─────────────────────────────────────────────────────────────

function post(backendUrl, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const url     = new URL(path, backendUrl);
    const lib     = url.protocol === 'https:' ? https : http;
    const options = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 3001),
      path:     url.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error));
          else              resolve(parsed);
        } catch { reject(new Error('Invalid JSON from backend')); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ─── Stepped review ───────────────────────────────────────────────────────────

/**
 * Human-in-the-loop review with 3 checkpoints:
 *   1. After Builder   → Approve / Stop
 *   2. After Factchecker → Approve / Stop & Get Verdict
 *   3. After Attacker  → Run Skeptic? Yes / No — then Finalize
 */
async function runReviewStepped(context, code, filePath, language, docs = []) {
  const cfg           = vscode.workspace.getConfiguration('codeReview');
  const backendUrl    = cfg.get('backendUrl') || 'http://127.0.0.1:3001';
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // Show spinning indicator in status bar for the whole review
  if (statusBarItem) {
    statusBarItem.text    = '$(sync~spin) Reviewing…';
    statusBarItem.tooltip = 'Multi-agent code review in progress';
  }

  // ── Step 1: Builder ─────────────────────────────────────────────────────────
  let startResult;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Step 1/3 — Builder analysing code…', cancellable: false },
    async () => {
      startResult = await post(backendUrl, '/review/start', { code, filePath, language, workspaceRoot, docs });
    }
  );

  const { sessionId, builderResult } = startResult;
  AgentStatusPanel.refresh(context, { agentResults: { builder: builderResult } });

  // ── Checkpoint 1: after Builder ─────────────────────────────────────────────
  const risks    = builderResult?.codeContext?.potentialRisks?.slice(0, 3).join(', ') || 'none flagged';
  const choice1  = await vscode.window.showInformationMessage(
    `Builder complete — Potential risks: ${risks}.\nContinue to Factchecker?`,
    { modal: true },
    'Approve & Continue',
    'Stop Review',
  );

  if (choice1 !== 'Approve & Continue') {
    const partial = await post(backendUrl, '/review/finalize', { sessionId });
    lastResult = partial;
    setStatusBarResult(partial);
    FindingsPanel.show(context, partial);
    VerdictPanel.refresh(context, partial);
    return vscode.window.showWarningMessage('Review stopped after Builder. Partial verdict generated.');
  }

  // ── Step 2: Factchecker ──────────────────────────────────────────────────────
  let factResult;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Step 2/3 — Factchecker running…', cancellable: false },
    async () => {
      const r = await post(backendUrl, '/review/next', { sessionId, agent: 'factchecker' });
      factResult = r.agentResult;
    }
  );

  // Show factchecker findings immediately so user can review before deciding
  const partial1 = { agentResults: { builder: builderResult, factchecker: factResult }, prioritizedFindings: [] };
  FindingsPanel.show(context, partial1);
  AgentStatusPanel.refresh(context, partial1);

  // ── Checkpoint 2: after Factchecker ─────────────────────────────────────────
  const factCount  = factResult?.findings?.length ?? 0;
  const factStatus = factResult?.status ?? 'unknown';
  const choice2    = await vscode.window.showWarningMessage(
    `Factchecker: ${factCount} finding(s) [${factStatus}].\nContinue to Security Scan (Attacker)?`,
    { modal: true },
    'Approve & Continue',
    'Stop & Get Verdict',
  );

  if (choice2 !== 'Approve & Continue') {
    const partial = await post(backendUrl, '/review/finalize', { sessionId });
    lastResult = partial;
    setStatusBarResult(partial);
    FindingsPanel.show(context, partial);
    SkepticChartsPanel.show(context, partial);
    AgentStatusPanel.refresh(context, partial);
    VerdictPanel.refresh(context, partial);
    const icon = { approve: '✅', 'request-changes': '⚠️', block: '🚫' }[partial.verdict] ?? '❓';
    return vscode.window.showInformationMessage(
      `${icon} Review stopped after Factchecker — ${partial.verdict?.toUpperCase()} | Score ${partial.score}/100`
    );
  }

  // ── Step 3: Attacker ────────────────────────────────────────────────────────
  let attackResult;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Step 3/3 — Security scan running…', cancellable: false },
    async () => {
      const r = await post(backendUrl, '/review/next', { sessionId, agent: 'attacker' });
      attackResult = r.agentResult;
    }
  );

  // Show attacker findings immediately
  const partial2 = { agentResults: { builder: builderResult, factchecker: factResult, attacker: attackResult }, prioritizedFindings: [] };
  FindingsPanel.show(context, partial2);
  AgentStatusPanel.refresh(context, partial2);

  // ── Checkpoint 3: ask about Skeptic ─────────────────────────────────────────
  const attackCount   = attackResult?.findings?.length ?? 0;
  const confirmedPocs = (attackResult?.findings || []).filter(f => f.exploitProof?.confirmed).length;
  const pocStr        = confirmedPocs ? ` (${confirmedPocs} exploit confirmed!)` : '';
  const choice3       = await vscode.window.showWarningMessage(
    `Attacker: ${attackCount} vulnerability/ies found${pocStr}.\nRun Skeptic for enhanced review?`,
    { modal: true },
    'Yes — Run Skeptic',
    'No — Get Verdict Now',
  );

  if (choice3 === 'Yes — Run Skeptic') {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Enhanced review — Skeptic running…', cancellable: false },
      async () => {
        await post(backendUrl, '/review/next', { sessionId, agent: 'skeptic' });
      }
    );
  }

  // ── Finalize: orchestrate all collected results ──────────────────────────────
  const finalResult = await post(backendUrl, '/review/finalize', { sessionId });
  lastResult = finalResult;
  setStatusBarResult(finalResult);
  FindingsPanel.show(context, finalResult);
  SkepticChartsPanel.show(context, finalResult);
  AgentStatusPanel.refresh(context, finalResult);
  VerdictPanel.refresh(context, finalResult);

  const icon = { approve: '✅', 'request-changes': '⚠️', block: '🚫' }[finalResult.verdict] ?? '❓';
  vscode.window.showInformationMessage(
    `${icon} Review complete: ${finalResult.verdict?.toUpperCase()} — Score ${finalResult.score}/100`
  );
}

// ─── Extension activation ─────────────────────────────────────────────────────

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  AgentStatusPanel.register(context);
  VerdictPanel.register(context);

  // ── Status bar item (bottom-left — shows verdict after each review) ────────
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'codeReview.showFindings';
  statusBarItem.text    = '$(shield) Code Review';
  statusBarItem.tooltip = 'Run a review: Ctrl+Shift+P → Code Review: Review Current File';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // ── Review current file (stepped) ────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('codeReview.reviewFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return vscode.window.showWarningMessage('No active editor found.');
      try {
        await runReviewStepped(
          context,
          editor.document.getText(),
          editor.document.fileName,
          editor.document.languageId,
        );
      } catch (err) {
        console.error('[CodeReview] reviewFile error:', err);
        vscode.window.showErrorMessage(`Review failed: ${err.message || String(err)}`);
      }
    })
  );

  // ── Review selection (stepped) ───────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('codeReview.reviewSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        return vscode.window.showWarningMessage('Select some code first.');
      }
      try {
        await runReviewStepped(
          context,
          editor.document.getText(editor.selection),
          editor.document.fileName,
          editor.document.languageId,
        );
      } catch (err) {
        console.error('[CodeReview] reviewSelection error:', err);
        vscode.window.showErrorMessage(`Review failed: ${err.message || String(err)}`);
      }
    })
  );

  // ── Review file + external docs (stepped) ────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('codeReview.reviewWithDocs', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return vscode.window.showWarningMessage('No active editor found.');

      const uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel:     'Select documentation file(s)',
        filters:       { 'Documents': ['md', 'txt', 'rst', 'adoc', 'html'] },
      });
      if (!uris || !uris.length) return;

      const fs   = require('fs');
      const path = require('path');
      const docs = uris.map(uri => ({
        name:    path.basename(uri.fsPath),
        content: (() => { try { return fs.readFileSync(uri.fsPath, 'utf8'); } catch { return ''; } })(),
      })).filter(d => d.content);

      if (!docs.length) return vscode.window.showWarningMessage('Could not read selected document(s).');

      try {
        await runReviewStepped(
          context,
          editor.document.getText(),
          editor.document.fileName,
          editor.document.languageId,
          docs,
        );
      } catch (err) {
        console.error('[CodeReview] reviewWithDocs error:', err);
        vscode.window.showErrorMessage(`Review failed: ${err.message || String(err)}`);
      }
    })
  );

  // ── Show findings ─────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('codeReview.showFindings', () =>
      FindingsPanel.show(context, lastResult)
    )
  );

  // ── Show charts ───────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('codeReview.showCharts', () =>
      SkepticChartsPanel.show(context, lastResult)
    )
  );

  // ── Auto-review on save (non-stepped — silent, full pipeline) ────────────
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      const cfg = vscode.workspace.getConfiguration('codeReview');
      if (!cfg.get('autoReviewOnSave')) return;
      const backendUrl    = cfg.get('backendUrl') || 'http://127.0.0.1:3001';
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (statusBarItem) { statusBarItem.text = '$(sync~spin) Auto-reviewing…'; }
      try {
        const body = {
          code:          document.getText(),
          filePath:      document.fileName,
          language:      document.languageId,
          workspaceRoot,
        };
        lastResult = await post(backendUrl, '/review', body);
        setStatusBarResult(lastResult);
        FindingsPanel.show(context, lastResult);
        AgentStatusPanel.refresh(context, lastResult);
        VerdictPanel.refresh(context, lastResult);
      } catch {
        if (statusBarItem) { statusBarItem.text = '$(shield) Code Review'; }
      }
    })
  );

  // Auto-open Code Review sidebar so the user can see it (focus first view in the container)
  vscode.commands.executeCommand('codeReview.agentStatus.focus').then(() => {}, () => {});

  vscode.window.showInformationMessage(
    'Code Review is active. Click the shield icon on the left to see results; if the backend runs on 3002/3003, set codeReview.backendUrl in Settings.'
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
