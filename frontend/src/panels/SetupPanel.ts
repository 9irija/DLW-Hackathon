import * as vscode from 'vscode';
import { getNonce }         from '../utils/messageHandler';
import type { DocEntry }    from '../types/agents';

/** Docs uploaded in the setup panel are kept here for use by the review flow. */
export let uploadedDocs: { name: string; content: string }[] = [];

export class SetupPanel {
  public  static readonly viewType = 'runchecks.setup';
  /** Called when user clicks "Start Review Session" — extension should run review with docs. */
  public static onStartSession: (() => void | Promise<void>) | undefined;

  private static _panel?: SetupPanel;

  private readonly _panel_: vscode.WebviewPanel;

  private constructor(panel: vscode.WebviewPanel, private readonly _extUri: vscode.Uri) {
    this._panel_ = panel;

    panel.webview.options = { enableScripts: true, localResourceRoots: [_extUri] };
    panel.webview.html    = this._getHtml();

    panel.webview.onDidReceiveMessage(msg => this._handleMessage(msg));
    panel.onDidDispose(() => { SetupPanel._panel = undefined; });
  }

  public static show(extensionUri: vscode.Uri): void {
    if (SetupPanel._panel) {
      SetupPanel._panel._panel_.reveal(vscode.ViewColumn.Active);
    } else {
      const panel = vscode.window.createWebviewPanel(
        SetupPanel.viewType,
        'RunChecks — Setup',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      SetupPanel._panel = new SetupPanel(panel, extensionUri);
    }
    SetupPanel._panel._refreshDocs();
  }

  private _refreshDocs(): void {
    const docs: DocEntry[] = uploadedDocs.map(d => ({
      filename:   d.name,
      uploadedAt: new Date().toISOString(),
      chunks:     Math.ceil(d.content.length / 1000),
    }));
    this._panel_.webview.postMessage({ type: 'updateDocs', docs });
  }

  private _handleMessage(msg: { type: string; name?: string; content?: string }): void {
    if (msg.type === 'uploadDoc') {
      uploadedDocs = uploadedDocs.filter(d => d.name !== msg.name!);
      uploadedDocs.push({ name: msg.name!, content: msg.content! });
      vscode.window.showInformationMessage(`RunChecks: "${msg.name}" loaded. It will be included in the next review.`);
      this._refreshDocs();
    }
    if (msg.type === 'deleteDoc') {
      uploadedDocs = uploadedDocs.filter(d => d.name !== msg.name!);
      vscode.window.showInformationMessage(`RunChecks: "${msg.name}" removed from this session.`);
      this._refreshDocs();
    }
    if (msg.type === 'startSession') {
      void Promise.resolve(SetupPanel.onStartSession?.()).catch(err =>
        vscode.window.showErrorMessage(`RunChecks: Failed to start review — ${(err as Error).message}`)
      );
    }
  }

  private _getHtml(): string {
    const nonce = getNonce();
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  *  { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
         color: var(--vscode-foreground); background: var(--vscode-editor-background);
         margin: 0; padding: 20px; max-width: 640px; }

  h2  { margin: 0 0 4px; font-size: 1rem; font-weight: 600; }
  .tagline { font-size: 0.75rem; color: var(--vscode-descriptionForeground); margin-bottom: 24px; }
  h3  { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em;
        color: var(--vscode-descriptionForeground); margin: 0 0 8px; }

  .doc-item  { display: flex; align-items: center; gap: 8px; padding: 6px 8px;
               border: 1px solid var(--vscode-panel-border); margin-bottom: 4px; }
  .doc-name  { flex: 1; font-size: 0.82rem; }
  .doc-meta  { font-size: 0.72rem; color: var(--vscode-descriptionForeground); }
  .doc-delete { border: none; background: transparent; color: var(--vscode-descriptionForeground);
                cursor: pointer; font-size: 0.8rem; padding: 2px 4px; }
  .doc-delete:hover { color: #f87171; }
  #docs-empty { color: var(--vscode-descriptionForeground); font-size: 0.82rem;
                padding: 10px 8px; }

  .btn { display: inline-block; padding: 6px 14px; cursor: pointer; font-size: 0.82rem;
         border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
         color: var(--vscode-button-foreground);
         background: var(--vscode-button-background); user-select: none; }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .btn-secondary { background: var(--vscode-button-secondaryBackground);
                   color: var(--vscode-button-secondaryForeground); }
  .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .actions { display: flex; gap: 8px; margin-top: 20px; }
  #status-msg { margin-top: 14px; font-size: 0.82rem; }
  .status-ready { color: #4ade80; }
  .status-error { color: #f87171; }
</style>
</head>
<body>
<h2>RunChecks — Setup</h2>
<div class="tagline">AI-powered code review. Human-controlled decisions.</div>

<h3>Loaded Documents</h3>
<div id="docs-list"><div id="docs-empty">No documents loaded.</div></div>

<div class="actions">
  <button class="btn btn-secondary" id="upload-btn">📎 Upload Document</button>
  <button class="btn" id="start-btn" disabled>▶ Start Review Session</button>
</div>
<input type="file" id="file-input" accept=".pdf,.md,.txt,.rst" style="display:none">
<div id="status-msg"></div>

<script nonce="${nonce}">
  const vscode    = acquireVsCodeApi();
  const uploadBtn = document.getElementById('upload-btn');
  const startBtn  = document.getElementById('start-btn');
  const statusEl  = document.getElementById('status-msg');
  const actionsEl = document.querySelector('.actions');

  uploadBtn.onclick = () =>
    document.getElementById('file-input').click();

  document.getElementById('file-input').onchange = e => {
    const file = e.target.files[0];
    if (!file) { return; }
    const reader = new FileReader();
    reader.onload = () => {
      vscode.postMessage({ type: 'uploadDoc', name: file.name, content: reader.result });
      statusEl.textContent = 'Uploading ' + file.name + '…';
      statusEl.className   = '';
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  startBtn.onclick = () => {
    vscode.postMessage({ type: 'startSession' });
    // Lock the setup panel for this session: hide actions and leave only the status message
    if (actionsEl) actionsEl.style.display = 'none';
    statusEl.textContent = 'Starting session…';
    statusEl.className   = '';
  };

  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type !== 'updateDocs') { return; }
    const docs = msg.docs || [];
    const list = document.getElementById('docs-list');
    if (!docs.length) {
      list.innerHTML = '<div id="docs-empty">No documents loaded.</div>';
      startBtn.disabled = true;
      statusEl.textContent = '';
      return;
    }
    list.innerHTML = docs.map(d =>
      '<div class="doc-item">' +
      '<span class="doc-name">📄 ' + escHtml(d.filename) + '</span>' +
      '<span class="doc-meta">' + new Date(d.uploadedAt).toLocaleTimeString() + ' &nbsp;·&nbsp; ' + d.chunks + ' chunks</span>' +
      '<button class="doc-delete" data-name="' + escHtml(d.filename) + '" title="Remove document">✖</button>' +
      '</div>'
    ).join('');
    // Wire delete buttons
    list.querySelectorAll('.doc-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = (btn as HTMLElement).getAttribute('data-name');
        if (!name) return;
        vscode.postMessage({ type: 'deleteDoc', name });
      });
    });
    startBtn.disabled = false;
    statusEl.textContent = '✅ RunChecks is ready to review your code';
    statusEl.className   = 'status-ready';
  });

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
</script>
</body>
</html>`;
  }
}
