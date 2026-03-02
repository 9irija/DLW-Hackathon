import * as vscode from 'vscode';
import { getNonce } from '../utils/messageHandler';
import { highlightLines, jumpToLine } from '../utils/highlighter';
import type { AgentResult, AgentFinding } from '../types/agents';
import type { FinalizeResponse } from '../utils/backendClient';

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

  // ─── Shared panel factory ──────────────────────────────────────────────────

  private static _getOrCreate(extensionUri: vscode.Uri): FindingsPanel {
    if (FindingsPanel._panel) {
      // Reveal with focus so the tab comes to the front
      FindingsPanel._panel._panel_.reveal(vscode.ViewColumn.Active, false);
      return FindingsPanel._panel;
    }
    const panel = vscode.window.createWebviewPanel(
      FindingsPanel.viewType,
      'RunChecks — Findings',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    FindingsPanel._panel = new FindingsPanel(panel, extensionUri);
    return FindingsPanel._panel;
  }

  // ─── Public entry points ───────────────────────────────────────────────────

  /** Show per-agent findings (factchecker / attacker). */
  public static show(extensionUri: vscode.Uri, result?: AgentResult): void {
    const fp = FindingsPanel._getOrCreate(extensionUri);
    if (result) { fp._renderFindings(result); }
  }

  /** Show Skeptic analysis results in the same tab. */
  public static showSkeptic(extensionUri: vscode.Uri, raw: Record<string, unknown>): void {
    const fp = FindingsPanel._getOrCreate(extensionUri);
    fp._panel_.title        = 'RunChecks — Skeptic Analysis';
    fp._panel_.webview.html = fp._getSkepticHtml(raw);
  }

  /** Show the final verdict page. */
  public static showVerdict(extensionUri: vscode.Uri, data: FinalizeResponse): void {
    const fp = FindingsPanel._getOrCreate(extensionUri);
    fp._panel_.title        = 'RunChecks — Final Verdict';
    fp._panel_.webview.html = fp._getVerdictHtml(data);
  }

  // ─── Internal renderers ────────────────────────────────────────────────────

  private _renderFindings(result: AgentResult): void {
    this._panel_.title        = `RunChecks — ${result.agentName} Findings`;
    this._panel_.webview.html = this._getFindingsHtml(result);

    // Highlight finding lines in the editor
    const bySeverity = new Map<string, number[]>();
    for (const f of result.findings) {
      if (!bySeverity.has(f.severity)) { bySeverity.set(f.severity, []); }
      bySeverity.get(f.severity)!.push(f.line);
    }
    bySeverity.forEach((lines, sev) => {
      highlightLines(result.findings[0]?.file ?? '', lines, sev as 'critical'|'high'|'medium'|'low')
        .catch(() => {/* ignore */});
    });
  }

  private async _handleMessage(msg: {
    type: string; stage?: string; decision?: string; file?: string; line?: number;
  }): Promise<void> {
    if (msg.type === 'decision') {
      FindingsPanel.onDecision?.(msg.stage!, msg.decision!);
    }
    if (msg.type === 'jumpToLine') {
      try { await jumpToLine(msg.file!, msg.line!); } catch { /* ignore */ }
    }
    if (msg.type === 'close') {
      FindingsPanel._panel?._panel_.dispose();
    }
  }

  // ─── HTML: Findings ────────────────────────────────────────────────────────

  private _getFindingsHtml(result: AgentResult): string {
    const nonce    = getNonce();
    const stageMap: Record<string, string> = {
      'pre-processing': 'Pre-processing — Parser & Reasoner',
      factchecker:      'Stage 1 — Compliance & Hallucination',
      attacker:         'Stage 2 — Security',
      skeptic:          'Stage 3 — Shadow Execution',
    };
    const stageLabel = stageMap[result.stage] ?? result.stage;

    const findingRows = result.findings.length
      ? result.findings.map(f => _findingCardHtml(f)).join('')
      : '<div class="all-clear">✅ All Clear — No issues found.</div>';

    const summaryHtml = result.summary
      ? `<div class="summary-box"><span class="label">Agent summary:</span> ${escHtml(result.summary)}</div>`
      : '';

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
${_commonStyles()}
</head>
<body>
<header>
  <h2>${escHtml(result.agentName)} Findings</h2>
  <div class="sub">${escHtml(stageLabel)} &nbsp;·&nbsp; ${result.findings.length} finding(s)</div>
</header>
<main>
  ${summaryHtml}
  ${findingRows}
</main>
<footer id="footer">
  <button class="btn btn-primary"   id="approve-btn">✅ Approve &amp; Continue</button>
  <button class="btn btn-secondary" id="changes-btn">✏️ Request Changes</button>
</footer>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const stage  = ${JSON.stringify(result.stage)};

  document.getElementById('approve-btn').onclick = () =>
    vscode.postMessage({ type: 'decision', stage, decision: 'approve' });

  document.getElementById('changes-btn').onclick = () => {
    // Replace footer with a message so buttons can't be pressed again
    document.getElementById('footer').innerHTML =
      '<div class="changes-msg">✏️ Changes requested — make your fixes then run RunChecks again.</div>';
    vscode.postMessage({ type: 'decision', stage, decision: 'change' });
  };

  document.querySelectorAll('.file-link').forEach(el => {
    el.addEventListener('click', () => {
      vscode.postMessage({ type: 'jumpToLine', file: el.dataset.file, line: Number(el.dataset.line) });
    });
  });
</script>
</body>
</html>`;
  }

  // ─── HTML: Skeptic ─────────────────────────────────────────────────────────

  private _getSkepticHtml(raw: Record<string, unknown>): string {
    const nonce   = getNonce();
    const tests   = raw['tests']   as { passed?: number; failed?: number; total?: number } | undefined;
    const traffic = raw['traffic'] as { endpoint: string; pass: number; fail: number }[]   | undefined;
    const latency = raw['latency'] as {
      endpoint: string;
      p50before: number; p50after: number;
      p90before: number; p90after: number;
      p99before: number; p99after: number;
    }[] | undefined;
    const journeys = raw['journeys'] as { name: string; status: string }[] | undefined;

    const testHtml = tests
      ? `<div class="counter-grid">
           <div class="counter passed"><span>${tests.passed ?? '—'}</span><label>Passed</label></div>
           <div class="counter failed"><span>${tests.failed ?? '—'}</span><label>Failed</label></div>
           <div class="counter total"><span>${tests.total ?? '—'}</span><label>Total</label></div>
         </div>`
      : '<p class="placeholder">No test data available.</p>';

    const latencyRows = (latency && latency.length)
      ? latency.map(r => {
          const p50c = r.p50after > r.p50before * 1.5 ? ' class="lat-up"' : '';
          const p90c = r.p90after > r.p90before * 1.5 ? ' class="lat-up"' : '';
          const p99c = r.p99after > r.p99before * 1.5 ? ' class="lat-up"' : '';
          return `<tr>
            <td>${escHtml(r.endpoint)}</td>
            <td${p50c}>${r.p50before}ms → ${r.p50after}ms</td>
            <td${p90c}>${r.p90before}ms → ${r.p90after}ms</td>
            <td${p99c}>${r.p99before}ms → ${r.p99after}ms</td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="4" class="placeholder">No latency data available.</td></tr>';

    const journeyHtml = (journeys && journeys.length)
      ? journeys.map(j => {
          const icon = j.status === 'unaffected' ? '✅' : j.status === 'broken' ? '🔴' : '🟡';
          return `<li>${icon} ${escHtml(j.name)} <span class="journey-status">${escHtml(j.status)}</span></li>`;
        }).join('')
      : '<li class="placeholder">No journey data available.</li>';

    // Inline traffic data so Chart.js renders immediately without a postMessage race
    const trafficJson = JSON.stringify(traffic ?? []);
    const hasTraffic  = (traffic && traffic.length) ? 'true' : 'false';

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline';
           script-src 'nonce-${nonce}' https://cdn.jsdelivr.net;
           connect-src https://cdn.jsdelivr.net;">
${_commonStyles()}
<style>
  .sec-hdr      { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em;
                  color: var(--vscode-descriptionForeground); margin: 0 0 10px; }
  section       { margin-bottom: 24px; }
  .counter-grid { display: flex; gap: 16px; }
  .counter      { flex: 1; text-align: center; padding: 14px 8px;
                  border: 1px solid var(--vscode-panel-border); }
  .counter span { font-size: 2.4rem; font-weight: 700; display: block; }
  .counter label{ font-size: 0.72rem; text-transform: uppercase;
                  letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); }
  .counter.passed span { color: #4ade80; }
  .counter.failed span { color: #f87171; }
  .counter.total  span { color: var(--vscode-foreground); }
  table    { border-collapse: collapse; width: 100%; font-size: 0.82rem; }
  th, td   { border: 1px solid var(--vscode-panel-border); padding: 5px 10px; text-align: left; }
  th       { color: var(--vscode-descriptionForeground); font-weight: 600;
             background: var(--vscode-editor-inactiveSelectionBackground); }
  .lat-up  { color: #f87171; font-weight: 600; }
  #journeys-list { list-style: none; margin: 0; padding: 0; }
  #journeys-list li { padding: 6px 0; font-size: 0.82rem;
                      border-bottom: 1px solid var(--vscode-panel-border); display: flex; gap: 6px; align-items: center; }
  .journey-status { font-size: 0.65rem; text-transform: uppercase; font-weight: 600;
                    color: var(--vscode-descriptionForeground); margin-left: auto; }
  #chart-wrap { position: relative; height: 220px; }
</style>
</head>
<body>
<header>
  <h2>Skeptic Analysis</h2>
  <div class="sub">Stage 3 (Optional) — Shadow execution &amp; latency impact</div>
</header>
<main>

  <section>
    <p class="sec-hdr">Test Results</p>
    ${testHtml}
  </section>

  <section>
    <p class="sec-hdr">Traffic Replay</p>
    ${hasTraffic === 'true'
      ? '<div id="chart-wrap"><canvas id="traffic-chart"></canvas></div>'
      : '<p class="placeholder">No traffic data available.</p>'}
  </section>

  <section>
    <p class="sec-hdr">Latency Impact
      <span style="font-size:0.65rem;font-weight:400;text-transform:none;letter-spacing:0">
        (p50 / p90 / p99 — before → after, 🔴 = &gt;50% regression)
      </span>
    </p>
    <table>
      <thead><tr><th>Endpoint</th><th>p50</th><th>p90</th><th>p99</th></tr></thead>
      <tbody>${latencyRows}</tbody>
    </table>
  </section>

  <section>
    <p class="sec-hdr">Affected User Journeys</p>
    <ul id="journeys-list">${journeyHtml}</ul>
  </section>

</main>
<footer id="footer">
  <button class="btn btn-primary"   id="approve-btn">✅ Approve &amp; Continue</button>
  <button class="btn btn-secondary" id="changes-btn">✏️ Request Changes</button>
</footer>

<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script nonce="${nonce}">
  const vscode      = acquireVsCodeApi();
  const trafficData = ${trafficJson};
  const hasTraffic  = ${hasTraffic};

  document.getElementById('approve-btn').onclick = () =>
    vscode.postMessage({ type: 'decision', stage: 'skeptic', decision: 'approve' });
  document.getElementById('changes-btn').onclick = () => {
    document.getElementById('footer').innerHTML =
      '<div class="changes-msg">✏️ Changes requested — make your fixes then run RunChecks again.</div>';
    vscode.postMessage({ type: 'decision', stage: 'skeptic', decision: 'change' });
  };

  if (hasTraffic) {
    const ctx = document.getElementById('traffic-chart').getContext('2d');
    new Chart(ctx, {
      type: 'bar',
      data: {
        labels:   trafficData.map(d => d.endpoint),
        datasets: [
          { label:'Pass', data: trafficData.map(d => d.pass), backgroundColor: 'rgba(34,197,94,0.6)' },
          { label:'Fail', data: trafficData.map(d => d.fail), backgroundColor: 'rgba(239,68,68,0.6)' },
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: 'var(--vscode-foreground)' } } },
        scales: {
          x: { ticks: { color: 'var(--vscode-foreground)' }, grid: { color: 'rgba(128,128,128,0.15)' } },
          y: { ticks: { color: 'var(--vscode-foreground)' }, grid: { color: 'rgba(128,128,128,0.15)' } }
        }
      }
    });
  }
</script>
</body>
</html>`;
  }

  // ─── HTML: Final Verdict ───────────────────────────────────────────────────

  private _getVerdictHtml(data: FinalizeResponse): string {
    const nonce    = getNonce();
    const verdict  = String(data.verdict ?? 'UNKNOWN');
    const score    = Number(data.score   ?? 0);
    const findings = (data.prioritizedFindings ?? []) as Record<string, unknown>[];

    const verdictColor =
      verdict === 'APPROVE'          ? '#4ade80' :
      verdict === 'BLOCK'            ? '#ef4444' :
      verdict === 'REQUEST CHANGES'  ? '#f97316' : '#94a3b8';

    const verdictIcon =
      verdict === 'APPROVE'          ? '✅' :
      verdict === 'BLOCK'            ? '🚫' :
      verdict === 'REQUEST CHANGES'  ? '⚠️'  : '❓';

    const sevCount: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of findings) {
      const sev = String(f['severity'] ?? '').toLowerCase();
      if (sev in sevCount) { sevCount[sev]++; }
    }

    const findingRows = findings.length
      ? findings.map(f => {
          const sev   = String(f['severity'] ?? 'low').toLowerCase();
          const desc  = String(f['description'] ?? f['claim'] ?? '');
          const sugg  = String(f['suggestion']  ?? '');
          const agent = String(f['agent']       ?? f['agentName'] ?? '');
          return `<div class="finding-card">
  <div class="finding-header">
    <span class="sev sev-${escHtml(sev)}">${escHtml(sev)}</span>
    ${agent ? `<span class="agent-chip">${escHtml(agent)}</span>` : ''}
  </div>
  <div class="finding-desc"><span class="label">Finding:</span> ${escHtml(desc)}</div>
  ${sugg ? `<div class="finding-suggestion"><span class="label">💡 Suggestion:</span> ${escHtml(sugg)}</div>` : ''}
</div>`;
        }).join('')
      : '<div class="all-clear">✅ No findings — code is clean.</div>';

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
${_commonStyles()}
<style>
  .verdict-banner { text-align: center; padding: 28px 20px 20px;
                    border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; }
  .verdict-icon   { font-size: 2.8rem; line-height: 1; }
  .verdict-text   { font-size: 1.6rem; font-weight: 800; letter-spacing: 0.04em;
                    margin: 8px 0 4px; color: ${escHtml(verdictColor)}; }
  .verdict-score  { font-size: 0.9rem; color: var(--vscode-descriptionForeground); }
  .sev-counts     { display: flex; gap: 10px; justify-content: center; margin-top: 14px; flex-wrap: wrap; }
  .sev-count      { font-size: 0.72rem; font-weight: 700; padding: 3px 12px;
                    border-radius: 2px; text-transform: uppercase; }
  .agent-chip     { font-size: 0.65rem; background: var(--vscode-editor-inactiveSelectionBackground);
                    padding: 2px 7px; border-radius: 2px; color: var(--vscode-descriptionForeground); }
  .findings-hdr   { font-size: 0.75rem; color: var(--vscode-descriptionForeground);
                    margin-bottom: 12px; padding-top: 2px; }
</style>
</head>
<body>

<div class="verdict-banner">
  <div class="verdict-icon">${verdictIcon}</div>
  <div class="verdict-text">${escHtml(verdict)}</div>
  <div class="verdict-score">Score: ${score} / 100</div>
  <div class="sev-counts">
    <span class="sev-count sev-critical">${sevCount['critical']} Critical</span>
    <span class="sev-count sev-high">${sevCount['high']} High</span>
    <span class="sev-count sev-medium">${sevCount['medium']} Medium</span>
    <span class="sev-count sev-low">${sevCount['low']} Low</span>
  </div>
</div>

<main>
  <div class="findings-hdr">${findings.length} finding(s) across all review stages</div>
  ${findingRows}
</main>

<footer>
  <button class="btn btn-secondary" id="close-btn">✖ Close Review</button>
</footer>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById('close-btn').onclick = () =>
    vscode.postMessage({ type: 'close' });
</script>
</body>
</html>`;
  }
}

// ─── Module-level helpers ──────────────────────────────────────────────────────

function escHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _commonStyles(): string {
  return `<style>
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
         color: var(--vscode-foreground); background: var(--vscode-editor-background);
         margin: 0; padding: 0; display: flex; flex-direction: column; height: 100vh; }

  header { padding: 14px 20px 10px; border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; }
  header h2  { margin: 0; font-size: 0.95rem; font-weight: 600; }
  header .sub{ font-size: 0.72rem; color: var(--vscode-descriptionForeground); margin-top: 2px; }

  main { flex: 1; overflow-y: auto; padding: 14px 20px; }

  .finding-card { border: 1px solid var(--vscode-panel-border); margin-bottom: 10px; padding: 10px 14px; }
  .finding-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }

  .sev { font-size: 0.65rem; font-weight: 700; padding: 2px 8px; border-radius: 2px;
         letter-spacing: 0.05em; text-transform: uppercase; }
  .sev-critical { background: rgba(239,68,68,0.15);  color: #ef4444; }
  .sev-high     { background: rgba(249,115,22,0.15); color: #f97316; }
  .sev-medium   { background: rgba(234,179,8,0.15);  color: #eab308; }
  .sev-low      { background: rgba(59,130,246,0.15); color: #3b82f6; }

  .file-link { font-size: 0.75rem; font-family: var(--vscode-editor-font-family);
               color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; }

  .label { font-size: 0.68rem; font-weight: 700; text-transform: uppercase;
           letter-spacing: 0.06em; color: var(--vscode-descriptionForeground);
           margin-right: 4px; }

  .finding-desc       { font-size: 0.82rem; margin-bottom: 4px; }
  .finding-suggestion { font-size: 0.78rem; color: var(--vscode-descriptionForeground); }

  .summary-box { background: var(--vscode-editor-inactiveSelectionBackground);
                 padding: 8px 12px; margin-bottom: 12px; font-size: 0.8rem;
                 border-left: 2px solid var(--vscode-focusBorder); }

  .all-clear { background: rgba(34,197,94,0.1); border: 1px solid #22c55e;
               color: #4ade80; padding: 20px; text-align: center;
               font-size: 0.9rem; font-weight: 600; }

  .placeholder { color: var(--vscode-descriptionForeground); font-size: 0.82rem; font-style: italic; }

  footer { padding: 12px 20px; border-top: 1px solid var(--vscode-panel-border);
           display: flex; gap: 10px; flex-shrink: 0; align-items: center; }

  .btn { padding: 7px 18px; cursor: pointer; font-size: 0.82rem; font-weight: 600;
         border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
         user-select: none; }
  .btn-primary   { background: var(--vscode-button-background);
                   color: var(--vscode-button-foreground); }
  .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
  .btn-secondary { background: var(--vscode-button-secondaryBackground);
                   color: var(--vscode-button-secondaryForeground); }
  .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }

  .changes-msg { font-size: 0.82rem; color: var(--vscode-descriptionForeground);
                 padding: 6px 0; font-style: italic; }
</style>`;
}

function _findingCardHtml(f: AgentFinding): string {
  const fileBase = f.file.split(/[\\/]/).pop() ?? f.file;
  return `<div class="finding-card">
  <div class="finding-header">
    <span class="sev sev-${escHtml(f.severity)}">${escHtml(f.severity)}</span>
    ${f.file && f.line
      ? `<span class="file-link" data-file="${escHtml(f.file)}" data-line="${f.line}">${escHtml(fileBase)} :${f.line}</span>`
      : ''}
  </div>
  <div class="finding-desc"><span class="label">Finding:</span> ${escHtml(f.description)}</div>
  ${f.suggestion
    ? `<div class="finding-suggestion"><span class="label">💡 Suggestion:</span> ${escHtml(f.suggestion)}</div>`
    : ''}
</div>`;
}
