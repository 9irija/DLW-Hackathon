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
      // Reveal in its own column (not "Active") so it doesn't replace the source editor
      const col = FindingsPanel._panel._panel_.viewColumn ?? vscode.ViewColumn.Beside;
      FindingsPanel._panel._panel_.reveal(col, false);
      return FindingsPanel._panel;
    }
    // Open beside the currently active source editor so both are visible side-by-side
    const panel = vscode.window.createWebviewPanel(
      FindingsPanel.viewType,
      'RunChecks — Findings',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
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

    // Highlight finding lines in the editor (only valid 1-based line numbers)
    const bySeverity = new Map<string, number[]>();
    for (const f of result.findings) {
      if (!f.line || f.line < 1) { continue; }  // skip doc findings with no line
      if (!bySeverity.has(f.severity)) { bySeverity.set(f.severity, []); }
      bySeverity.get(f.severity)!.push(f.line);
    }
    const fileForHighlight = result.findings.find(f => f.file)?.file ?? '';
    if (fileForHighlight) {
      bySeverity.forEach((lines, sev) => {
        highlightLines(fileForHighlight, lines, sev as 'critical'|'high'|'medium'|'low')
          .catch(() => {/* ignore */});
      });
    }
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
      ? `<div class="summary-box">
           <div class="summary-title">Agent Summary</div>
           <div class="summary-meta">
             <span>${escHtml(result.agentName)}</span>
             <span class="dot">•</span>
             <span>${escHtml(stageLabel)}</span>
             <span class="dot">•</span>
             <span>${result.findings.length} finding(s)</span>
             <span class="dot">•</span>
             <span class="${result.passed ? 'status-pass' : 'status-fail'}">${result.passed ? '✅ No blockers' : '⚠️ Issues found'}</span>
           </div>
           ${_formatSummaryHtml(result.summary)}
         </div>`
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
  <button class="btn btn-secondary" id="changes-btn">✏️ Make Changes</button>
</footer>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const stage  = ${JSON.stringify(result.stage)};

  document.getElementById('approve-btn').onclick = () =>
    vscode.postMessage({ type: 'decision', stage, decision: 'approve' });

  document.getElementById('changes-btn').onclick = () => {
    // Replace footer with a message so buttons can't be pressed again
    document.getElementById('footer').innerHTML =
      '<div class="changes-msg">✏️ Make your changes, then run RunChecks again.</div>';
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
    const evidence = raw['evidence'] as {
      failureTimeline?: { passed?: boolean; failed?: boolean }[];
      endpointHeatmap?: { endpoint: string; passed: number; failed: number }[];
      latencyDistribution?: { before?: number[]; after?: number[]; unit?: string };
      userJourneyFailures?: { name: string; failed?: boolean }[];
    } | undefined;

    const directTests = raw['tests'] as { passed?: number; failed?: number; total?: number } | undefined;
    const tests = directTests ?? (evidence?.failureTimeline
      ? {
          passed: evidence.failureTimeline.filter(p => p.passed).length,
          failed: evidence.failureTimeline.filter(p => p.failed).length,
          total:  evidence.failureTimeline.length,
        }
      : undefined);

    const directTraffic = raw['traffic'] as { endpoint: string; pass: number; fail: number }[] | undefined;
    const traffic = directTraffic ?? (evidence?.endpointHeatmap
      ? evidence.endpointHeatmap.map(e => ({
          endpoint: String(e.endpoint ?? ''),
          pass:     Number(e.passed ?? 0),
          fail:     Number(e.failed ?? 0),
        }))
      : undefined);

    const directLatency = raw['latency'] as {
      endpoint: string;
      p50before: number; p50after: number;
      p90before: number; p90after: number;
      p99before: number; p99after: number;
    }[] | undefined;

    const latency = directLatency ?? (evidence?.latencyDistribution
      ? (() => {
          const before = evidence.latencyDistribution!.before ?? [];
          const after  = evidence.latencyDistribution!.after  ?? [];
          if (!before.length && !after.length) return undefined;
          const p = (vals: number[], q: number) => _percentile(vals, q);
          return [{
            endpoint:  'overall',
            p50before: before.length ? p(before, 0.5) : 0,
            p50after:  after.length  ? p(after,  0.5) : 0,
            p90before: before.length ? p(before, 0.9) : 0,
            p90after:  after.length  ? p(after,  0.9) : 0,
            p99before: before.length ? p(before, 0.99) : 0,
            p99after:  after.length  ? p(after,  0.99) : 0,
          }];
        })()
      : undefined);

    const directJourneys = raw['journeys'] as { name: string; status: string }[] | undefined;
    const journeys = directJourneys ?? (evidence?.userJourneyFailures
      ? evidence.userJourneyFailures.map(j => ({
          name:   String(j.name ?? 'Unknown journey'),
          status: 'broken',
        }))
      : undefined);

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

    // ── Recommendation ─────────────────────────────────────────────────────────
    const rec = raw['recommendation'] as
      { action: string; label: string; reasons: string[] } | undefined;

    const recActionSafe = rec?.action === 'approve' ? 'approve'
                        : rec?.action === 'hold'    ? 'hold'
                        :                             'review';

    const recIcon  = recActionSafe === 'approve' ? '✅'
                   : recActionSafe === 'hold'    ? '🚫' : '⚠️';

    const recHtml = rec
      ? `<div class="rec-card rec-${recActionSafe}">
           <div class="rec-icon">${recIcon}</div>
           <div class="rec-body">
             <div class="rec-label">${escHtml(rec.label)}</div>
             ${rec.reasons.length
               ? `<ul class="rec-reasons">${rec.reasons.map(r => `<li>${escHtml(r)}</li>`).join('')}</ul>`
               : ''}
           </div>
         </div>`
      : '';

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
  th       { color: var(--vscode-foreground); font-weight: 600;
             background: var(--vscode-editor-inactiveSelectionBackground); }
  td       { color: var(--vscode-foreground); }
  .lat-up  { color: #f87171; font-weight: 600; }
  .sec-explain { font-size: 0.72rem; color: var(--vscode-descriptionForeground);
                 margin: -6px 0 8px; font-style: italic; }
  #journeys-list { list-style: none; margin: 0; padding: 0; }
  #journeys-list li { padding: 6px 0; font-size: 0.82rem;
                      border-bottom: 1px solid var(--vscode-panel-border); display: flex; gap: 6px; align-items: center; }
  .journey-status { font-size: 0.65rem; text-transform: uppercase; font-weight: 600;
                    color: var(--vscode-descriptionForeground); margin-left: auto; }
  #chart-wrap { position: relative; height: 220px; }
  /* Recommendation banner */
  .rec-card    { display: flex; align-items: flex-start; gap: 14px; padding: 14px 16px;
                 margin-bottom: 20px; border-left: 4px solid; border-radius: 2px; }
  .rec-approve { border-color: #4ade80; background: rgba(74,222,128,0.08); }
  .rec-review  { border-color: #f97316; background: rgba(249,115,22,0.08); }
  .rec-hold    { border-color: #ef4444; background: rgba(239,68,68,0.08); }
  .rec-icon    { font-size: 1.6rem; line-height: 1; flex-shrink: 0; margin-top: 1px; }
  .rec-body    { flex: 1; min-width: 0; }
  .rec-label   { font-size: 0.88rem; font-weight: 700; margin-bottom: 6px;
                 color: var(--vscode-foreground); }
  .rec-reasons { margin: 0; padding-left: 16px; }
  .rec-reasons li { font-size: 0.78rem; color: var(--vscode-foreground);
                    margin-bottom: 3px; word-break: break-word; }
</style>
</head>
<body>
<header>
  <h2>Skeptic Analysis</h2>
  <div class="sub">Stage 3 (Optional) — Shadow execution &amp; latency impact</div>
</header>
<main>

  ${recHtml}

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
    <p class="sec-hdr">Latency Impact</p>
    <p class="sec-explain">
      Measures how long the code takes to run. <strong>p50</strong> = median (half of runs are faster),
      <strong>p90</strong> = slowest 10%, <strong>p99</strong> = slowest 1% (worst-case).
      Values show: <em>before this change → after this change</em>. 🔴 means &gt;50% slower (regression).
    </p>
    <table>
      <thead><tr><th>Endpoint / File</th><th>p50 (median)</th><th>p90 (slow)</th><th>p99 (worst)</th></tr></thead>
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
  <button class="btn btn-secondary" id="changes-btn">✏️ Make Changes</button>
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
      '<div class="changes-msg">✏️ Make your changes, then run RunChecks again.</div>';
    vscode.postMessage({ type: 'decision', stage: 'skeptic', decision: 'change' });
  };

  if (hasTraffic) {
    // Chart.js does not resolve CSS variables — read the actual computed colour at runtime
    const fgColor = getComputedStyle(document.body).getPropertyValue('--vscode-foreground').trim() || '#cccccc';
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
        plugins: { legend: { labels: { color: fgColor } } },
        scales: {
          x: { ticks: { color: fgColor }, grid: { color: 'rgba(128,128,128,0.15)' } },
          y: { ticks: { color: fgColor }, grid: { color: 'rgba(128,128,128,0.15)' } }
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
    // Normalize: backend returns lowercase/hyphenated ('approve', 'request-changes')
    const verdict  = _normalizeVerdict(String(data.verdict ?? 'UNKNOWN'));
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

    const groupedHtml = findings.length
      ? (() => {
          const byAgent = new Map<string, Record<string, unknown>[]>();
          for (const f of findings) {
            const agentKey = String(
              f['agent'] ??
              f['agentName'] ??
              f['source'] ??
              'other'
            ).toLowerCase();
            if (!byAgent.has(agentKey)) byAgent.set(agentKey, []);
            byAgent.get(agentKey)!.push(f);
          }

          const order = ['factchecker', 'attacker', 'skeptic'];
          const labels: Record<string, string> = {
            factchecker: 'Fact Checker',
            attacker:    'Attacker',
            skeptic:     'Skeptic',
          };

          const orderedKeys = [
            ...order.filter(k => byAgent.has(k)),
            ...Array.from(byAgent.keys()).filter(k => !order.includes(k)),
          ];

          return orderedKeys.map(agentKey => {
            const agentFindings = byAgent.get(agentKey)!;
            const title = labels[agentKey] ?? (agentKey ? agentKey : 'Other');
            // Reuse the same rich card format as the individual findings pages
            const cards = agentFindings
              .map(f => _findingCardHtml(_rawFindingToAgentFinding(f)))
              .join('');

            return `<section class="agent-section">
  <h3 class="agent-section-title">${escHtml(title)} findings</h3>
  ${cards}
</section>`;
          }).join('');
        })()
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
  ${groupedHtml}
</main>

<footer>
  <button class="btn btn-secondary" id="close-btn">✖ Close Review</button>
</footer>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById('close-btn').onclick = () =>
    vscode.postMessage({ type: 'close' });

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
  .summary-title { font-size: 0.72rem; text-transform: uppercase;
                  letter-spacing: 0.06em; color: var(--vscode-descriptionForeground);
                  margin-bottom: 2px; font-weight: 700; }
  .summary-meta  { font-size: 0.7rem; color: var(--vscode-descriptionForeground);
                  margin-bottom: 6px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .summary-meta .dot { opacity: 0.6; }
  .summary-body { font-size: 0.8rem; color: var(--vscode-foreground); }
  .summary-lines { list-style: none; margin: 4px 0 0; padding: 0; }
  .summary-lines li { padding: 3px 0; font-size: 0.8rem; color: var(--vscode-foreground);
                      border-bottom: 1px solid var(--vscode-panel-border); }
  .summary-lines li:last-child { border-bottom: none; }
  .summary-doc { font-weight: 700; color: var(--vscode-foreground); margin-right: 4px; }
  .status-pass { color: #4ade80; font-weight: 600; }
  .status-fail { color: #f97316; font-weight: 600; }

  /* Factchecker rich card */
  .fc-card .code-snippet { font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.78rem; background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-panel-border); padding: 6px 10px;
    margin: 4px 0; white-space: pre; overflow-x: auto; display: block; border-radius: 2px; }
  .finding-section { margin-bottom: 6px; }
  .finding-claim { font-style: italic; color: var(--vscode-foreground);
                   display: block; margin: 2px 0 1px; }
  .doc-ref { display: block; font-size: 0.68rem; color: var(--vscode-descriptionForeground);
             margin-top: 2px; }
  .doc-badge { font-size: 0.65rem; background: rgba(59,130,246,0.15); color: #3b82f6;
               padding: 2px 7px; border-radius: 2px; }

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

  .agent-section      { margin-bottom: 18px; }
  .agent-section-title{ font-size: 0.8rem; font-weight: 600;
                        margin: 0 0 6px; color: var(--vscode-descriptionForeground);
                        text-transform: uppercase; letter-spacing: 0.06em; }
</style>`;
}

function _findingCardHtml(f: AgentFinding): string {
  // Factchecker findings carry claim/codeSnippet/reality — render them richly
  if (f.claim || f.codeSnippet || f.reality) {
    return _factcheckerCardHtml(f);
  }
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

/** Rich card for factchecker findings that have claim / codeSnippet / docSource fields. */
function _factcheckerCardHtml(f: AgentFinding): string {
  const fileBase = f.file ? (f.file.split(/[\\/]/).pop() ?? f.file) : '';

  // ── Code snippet (inline check has line + codeSnippet) ────────────────────
  const codeSection = f.codeSnippet
    ? `<div class="finding-section">
  <span class="label">Code:</span>
  <pre class="code-snippet">${escHtml(f.codeSnippet)}</pre>${
      f.file && f.line
        ? `\n  <span class="file-link" data-file="${escHtml(f.file)}" data-line="${f.line}">↗ ${escHtml(fileBase)} line ${f.line}</span>`
        : ''
  }
</div>`
    : (f.file && f.line
        ? `<div class="finding-section"><span class="file-link" data-file="${escHtml(f.file)}" data-line="${f.line}">↗ From line ${f.line} in ${escHtml(fileBase)}</span></div>`
        : '');

  // ── Doc reference chip (external doc findings) ────────────────────────────
  const docParts: string[] = [];
  if (f.docSource)  docParts.push(escHtml(f.docSource));
  if (f.docSection && f.docSection !== 'unknown' && f.docSection !== 'requirements') {
    docParts.push(`§ ${escHtml(f.docSection)}`);
  }
  if (f.docPage != null) docParts.push(`page ${f.docPage}`);
  const docRefHtml = docParts.length
    ? `<span class="doc-ref">from ${docParts.join(' · ')}</span>`
    : '';

  // ── Claim (what the comment / document says) ──────────────────────────────
  const claimSection = f.claim
    ? `<div class="finding-section">
  <span class="label">Comment/Doc:</span>
  <span class="finding-claim">${escHtml(f.claim)}</span>
  ${docRefHtml}
</div>`
    : (docRefHtml ? `<div class="finding-section">${docRefHtml}</div>` : '');

  // ── Finding = reality (what the code actually does) ───────────────────────
  const findingText  = f.reality || f.description;
  const findingSection = findingText
    ? `<div class="finding-desc"><span class="label">Finding:</span> ${escHtml(findingText)}</div>`
    : '';

  return `<div class="finding-card fc-card">
  <div class="finding-header">
    <span class="sev sev-${escHtml(f.severity)}">${escHtml(f.severity)}</span>
    ${f.docSource ? `<span class="doc-badge">📄 ${escHtml(f.docSource)}</span>` : ''}
  </div>
  ${codeSection}
  ${claimSection}
  ${findingSection}
  ${f.suggestion
    ? `<div class="finding-suggestion"><span class="label">💡 Suggestion:</span> ${escHtml(f.suggestion)}</div>`
    : ''}
</div>`;
}

/** Format a pipe-separated agent summary into a readable list. */
function _formatSummaryHtml(raw: string): string {
  if (!raw) return '';
  const parts = raw.split(' | ').map(p => p.trim()).filter(Boolean);
  if (parts.length <= 1) {
    return `<div class="summary-body">${escHtml(raw)}</div>`;
  }
  const items = parts.map(p => {
    // Match [DocName] or [Tag] prefix
    const m = p.match(/^\[([^\]]+)\]\s*(.*)/s);
    if (m) {
      return `<li><span class="summary-doc">[${escHtml(m[1])}]</span> ${escHtml(m[2].trim() || m[1])}</li>`;
    }
    return `<li>${escHtml(p)}</li>`;
  }).join('');
  return `<ul class="summary-lines">${items}</ul>`;
}

/**
 * Convert a raw backend finding object (from prioritizedFindings) to an AgentFinding
 * so the verdict page can reuse the same rich card renderers as the findings page.
 */
function _rawFindingToAgentFinding(f: Record<string, unknown>): AgentFinding {
  const sev = String(f['severity'] ?? '').toLowerCase();
  return {
    type:        String(f['type']      ?? f['category']    ?? 'issue'),
    severity:    (['critical','high','medium','low'].includes(sev) ? sev : 'low') as AgentFinding['severity'],
    file:        String(f['filePath']  ?? f['file']        ?? ''),
    line:        Number(f['line']      ?? 0),
    description: String(f['description'] ?? f['reality']  ?? f['claim'] ?? ''),
    suggestion:  String(f['suggestion'] ?? ''),
    codeSnippet: f['codeSnippet'] ? String(f['codeSnippet']) : undefined,
    claim:       f['claim']       ? String(f['claim'])       : undefined,
    reality:     f['reality']     ? String(f['reality'])     : undefined,
    docSource:   f['docSource']   ? String(f['docSource'])   : undefined,
    docSection:  f['docSection']  ? String(f['docSection'])  : undefined,
    docPage:     f['docPage'] != null ? Number(f['docPage']) : undefined,
  };
}

/** Normalise backend verdict strings (lowercase/hyphenated) to display form. */
function _normalizeVerdict(raw: string): string {
  const v = (raw ?? '').toLowerCase();
  if (v === 'approve')                                return 'APPROVE';
  if (v === 'block')                                  return 'BLOCK';
  if (v === 'request-changes' || v.includes('change')) return 'REQUEST CHANGES';
  return (raw ?? '').toUpperCase();
}

function _percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  const weight = idx - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}
