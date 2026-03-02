import * as vscode from 'vscode';
import { getNonce } from '../utils/messageHandler';
import { highlightLines, jumpToLine } from '../utils/highlighter';
import type { AgentResult, AgentFinding } from '../types/agents';

export class FindingsPanel {
  public  static readonly viewType = 'runchecks.findings';
  private static _panel?: FindingsPanel;

  /** Called by extension.ts when the user approves or requests changes. */
  public static onDecision: ((stage: string, decision: string) => void) | undefined;

  private readonly _panel_: vscode.WebviewPanel;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly _extUri: vscode.Uri
  ) {
    this._panel_ = panel;
    panel.webview.options = { enableScripts: true, localResourceRoots: [_extUri] };
    panel.webview.onDidReceiveMessage(msg => this._handleMessage(msg));
    panel.onDidDispose(() => { FindingsPanel._panel = undefined; });
  }

  public static show(extensionUri: vscode.Uri, result?: AgentResult): void {
    if (FindingsPanel._panel) {
      FindingsPanel._panel._panel_.reveal(vscode.ViewColumn.Active);
    } else {
      const panel = vscode.window.createWebviewPanel(
        FindingsPanel.viewType,
        'RunChecks — Findings',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      FindingsPanel._panel = new FindingsPanel(panel, extensionUri);
    }
    if (result) { FindingsPanel._panel.update(result); }
  }

  public update(result: AgentResult): void {
    const title = `RunChecks — ${result.agentName} Findings`;
    this._panel_.title        = title;
    this._panel_.webview.html = this._getHtml(result);

    // Highlight lines in the editor for every finding
    const bySeverity = new Map<string, number[]>();
    for (const f of result.findings) {
      if (!bySeverity.has(f.severity)) { bySeverity.set(f.severity, []); }
      bySeverity.get(f.severity)!.push(f.line);
    }
    bySeverity.forEach((lines, sev) => {
      highlightLines(result.findings[0]?.file ?? '', lines, sev as 'critical'|'high'|'medium'|'low').catch(() => {/* ignore */});
    });
  }

  private async _handleMessage(msg: { type: string; stage?: string; decision?: string; file?: string; line?: number }): Promise<void> {
    if (msg.type === 'decision') {
      FindingsPanel.onDecision?.(msg.stage!, msg.decision!);
    }
    if (msg.type === 'jumpToLine') {
      try { await jumpToLine(msg.file!, msg.line!); } catch { /* ignore */ }
    }
    if (msg.type === 'runSkeptic') {
      FindingsPanel.onDecision?.(msg.stage ?? 'attacker', 'runSkeptic');
    }
  }

  private _getHtml(result: AgentResult): string {
    const nonce    = getNonce();
    const stageMap: Record<string, string> = {
      'pre-processing': 'Pre-processing — Parser & Reasoner',
      factchecker:      'Stage 1 — Compliance & Hallucination',
      attacker:         'Stage 2 — Security',
      skeptic:          'Stage 3 — Confidence (Optional)',
    };
    const stageLabel = stageMap[result.stage] ?? result.stage;
    const isAttacker = result.stage === 'attacker';

    const findingRows = result.findings.length
      ? result.findings.map(f => _findingHtml(f)).join('')
      : '<div class="all-clear">✅ All Clear — No issues found.</div>';

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
         color: var(--vscode-foreground); background: var(--vscode-editor-background);
         margin: 0; padding: 0; display: flex; flex-direction: column; height: 100vh; }

  header { padding: 14px 20px 10px; border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; }
  header h2 { margin: 0; font-size: 0.95rem; font-weight: 600; }
  header .sub { font-size: 0.72rem; color: var(--vscode-descriptionForeground); margin-top: 2px; }

  main { flex: 1; overflow-y: auto; padding: 14px 20px; }

  .finding-card { border: 1px solid var(--vscode-panel-border); margin-bottom: 10px; padding: 10px 14px; }
  .finding-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .sev { font-size: 0.65rem; font-weight: 700; padding: 2px 8px; border-radius: 2px;
         letter-spacing: 0.05em; text-transform: uppercase; }
  .sev-critical { background: rgba(239,68,68,0.15);  color: #ef4444; }
  .sev-high     { background: rgba(249,115,22,0.15); color: #f97316; }
  .sev-medium   { background: rgba(234,179,8,0.15);  color: #eab308; }
  .sev-low      { background: rgba(59,130,246,0.15); color: #3b82f6; }
  .file-link { font-size: 0.75rem; font-family: var(--vscode-editor-font-family);
               color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; }
  .finding-desc { font-size: 0.82rem; margin-bottom: 4px; }
  .finding-suggestion { font-size: 0.78rem; color: var(--vscode-descriptionForeground); }
  .finding-suggestion::before { content: '💡 '; }

  .all-clear { background: rgba(34,197,94,0.1); border: 1px solid #22c55e;
               color: #4ade80; padding: 20px; text-align: center; font-size: 0.9rem; font-weight: 600; }

  .skeptic-prompt { background: var(--vscode-editor-inactiveSelectionBackground);
                    padding: 10px 14px; margin-bottom: 12px; font-size: 0.82rem; }
  .skeptic-prompt p { margin: 0 0 8px; }
  .skeptic-buttons { display: flex; gap: 8px; }

  footer { padding: 12px 20px; border-top: 1px solid var(--vscode-panel-border);
           display: flex; gap: 10px; flex-shrink: 0; }
  .btn { padding: 7px 18px; cursor: pointer; font-size: 0.82rem; font-weight: 600;
         border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
         user-select: none; }
  .btn-primary   { background: var(--vscode-button-background);
                   color: var(--vscode-button-foreground); }
  .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
  .btn-secondary { background: var(--vscode-button-secondaryBackground);
                   color: var(--vscode-button-secondaryForeground); }
  .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
</style>
</head>
<body>
<header>
  <h2>${escHtml(result.agentName)} Findings</h2>
  <div class="sub">${escHtml(stageLabel)} &nbsp;·&nbsp; ${result.findings.length} finding(s)</div>
</header>
<main>
  ${isAttacker && !result.passed ? `
  <div class="skeptic-prompt">
    <p>Run Skeptic shadow analysis? This will execute your test suite.</p>
    <div class="skeptic-buttons">
      <button class="btn btn-secondary" id="run-skeptic-btn">🧪 Yes — Run Skeptic</button>
      <button class="btn btn-secondary" id="skip-skeptic-btn">Skip</button>
    </div>
  </div>` : ''}
  ${findingRows}
</main>
<footer>
  <button class="btn btn-primary"   id="approve-btn">✅ Approve &amp; Continue</button>
  <button class="btn btn-secondary" id="changes-btn">✏️ Request Changes</button>
</footer>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const stage  = ${JSON.stringify(result.stage)};

  document.getElementById('approve-btn').onclick = () =>
    vscode.postMessage({ type: 'decision', stage, decision: 'approve' });
  document.getElementById('changes-btn').onclick = () =>
    vscode.postMessage({ type: 'decision', stage, decision: 'change' });

  const rskBtn = document.getElementById('run-skeptic-btn');
  const skpBtn = document.getElementById('skip-skeptic-btn');
  if (rskBtn) { rskBtn.onclick = () => vscode.postMessage({ type: 'runSkeptic' }); }
  if (skpBtn) { skpBtn.onclick = () => skpBtn.closest('.skeptic-prompt')?.remove(); }

  document.querySelectorAll('.file-link').forEach(el => {
    el.addEventListener('click', () => {
      vscode.postMessage({ type: 'jumpToLine', file: el.dataset.file, line: Number(el.dataset.line) });
    });
  });
</script>
</body>
</html>`;
  }
}

function escHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _findingHtml(f: AgentFinding): string {
  const fileBase = f.file.split(/[\\/]/).pop() ?? f.file;
  return `
<div class="finding-card">
  <div class="finding-header">
    <span class="sev sev-${escHtml(f.severity)}">${escHtml(f.severity)}</span>
    <span class="file-link" data-file="${escHtml(f.file)}" data-line="${f.line}">
      ${escHtml(fileBase)} :${f.line}
    </span>
  </div>
  <div class="finding-desc">${escHtml(f.description)}</div>
  <div class="finding-suggestion">${escHtml(f.suggestion)}</div>
</div>`;
}
