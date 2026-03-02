import * as vscode from 'vscode';
import { getNonce } from '../utils/messageHandler';
import type { SkepticData } from '../types/agents';

export class SkepticPanel {
  public  static readonly viewType = 'runchecks.skeptic';
  private static _panel?: SkepticPanel;

  /** Called by extension.ts when the user approves or requests changes. */
  public static onDecision: ((decision: string) => void) | undefined;

  private readonly _panel_: vscode.WebviewPanel;

  private constructor(panel: vscode.WebviewPanel, private readonly _extUri: vscode.Uri) {
    this._panel_ = panel;
    panel.webview.options = { enableScripts: true, localResourceRoots: [_extUri] };
    panel.webview.html    = this._getHtml();
    panel.webview.onDidReceiveMessage(msg => this._handleMessage(msg));
    panel.onDidDispose(() => { SkepticPanel._panel = undefined; });
  }

  public static show(extensionUri: vscode.Uri, data?: SkepticData): void {
    if (SkepticPanel._panel) {
      SkepticPanel._panel._panel_.reveal(vscode.ViewColumn.Active);
    } else {
      const panel = vscode.window.createWebviewPanel(
        SkepticPanel.viewType,
        'RunChecks — Skeptic Analysis',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      SkepticPanel._panel = new SkepticPanel(panel, extensionUri);
    }
    if (data) { SkepticPanel._panel.update(data); }
  }

  public update(data: SkepticData): void {
    this._panel_.webview.postMessage({ type: 'updateResults', data });
  }

  private _handleMessage(msg: { type: string; decision?: string }): void {
    if (msg.type === 'decision') {
      SkepticPanel.onDecision?.(msg.decision!);
    }
  }

  private _getHtml(): string {
    const nonce = getNonce();
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline';
           script-src 'nonce-${nonce}' https://cdn.jsdelivr.net;
           connect-src https://cdn.jsdelivr.net;">
<style>
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
         color: var(--vscode-foreground); background: var(--vscode-editor-background);
         margin: 0; padding: 0; display: flex; flex-direction: column; height: 100vh; }

  header { padding: 14px 20px 10px; border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; }
  header h2 { margin: 0; font-size: 0.95rem; font-weight: 600; }
  main   { flex: 1; overflow-y: auto; padding: 14px 20px; }

  section  { margin-bottom: 24px; }
  .sec-hdr { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em;
             color: var(--vscode-descriptionForeground); margin: 0 0 10px; }

  /* Section 1 — Test counters */
  .counter-grid { display: flex; gap: 16px; }
  .counter      { flex: 1; text-align: center; padding: 14px 8px;
                  border: 1px solid var(--vscode-panel-border); }
  .counter span { font-size: 2.4rem; font-weight: 700; display: block; }
  .counter label{ font-size: 0.72rem; text-transform: uppercase;
                  letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); }
  .counter.passed span { color: #4ade80; }
  .counter.failed span { color: #f87171; }
  .counter.total  span { color: var(--vscode-foreground); }

  /* Section 3 — Latency table */
  table { border-collapse: collapse; width: 100%; font-size: 0.82rem; }
  th, td { border: 1px solid var(--vscode-panel-border); padding: 5px 10px; text-align: left; }
  th { color: var(--vscode-descriptionForeground); font-weight: 600; background: var(--vscode-editor-inactiveSelectionBackground); }
  .latency-up { color: #f87171; font-weight: 600; }

  /* Section 4 — Journeys */
  #journeys-list { list-style: none; margin: 0; padding: 0; }
  #journeys-list li { padding: 5px 0; font-size: 0.82rem;
                      border-bottom: 1px solid var(--vscode-panel-border); }

  /* Section 5 — Flow SVG */
  #flow-wrap  { border: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-inactiveSelectionBackground); overflow: auto; }

  /* Chart container */
  #chart-wrap { position: relative; height: 220px; }

  /* Loading placeholder */
  .placeholder { color: var(--vscode-descriptionForeground); font-size: 0.82rem;
                 font-style: italic; padding: 8px 0; }

  footer { padding: 12px 20px; border-top: 1px solid var(--vscode-panel-border);
           display: flex; gap: 10px; flex-shrink: 0; }
  .btn { padding: 7px 18px; cursor: pointer; font-size: 0.82rem; font-weight: 600;
         border: 1px solid var(--vscode-button-border, var(--vscode-panel-border)); user-select: none; }
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
  <h2>Skeptic Analysis</h2>
</header>
<main>

  <!-- Section 1: Test Results -->
  <section>
    <p class="sec-hdr">Test Results</p>
    <div class="counter-grid">
      <div class="counter passed"><span id="cnt-passed">—</span><label>Passed</label></div>
      <div class="counter failed"><span id="cnt-failed">—</span><label>Failed</label></div>
      <div class="counter total" ><span id="cnt-total" >—</span><label>Total</label></div>
    </div>
  </section>

  <!-- Section 2: Traffic Replay -->
  <section>
    <p class="sec-hdr">Traffic Replay</p>
    <div id="chart-wrap"><canvas id="traffic-chart"></canvas></div>
    <p id="chart-placeholder" class="placeholder">No traffic data.</p>
  </section>

  <!-- Section 3: Latency Impact -->
  <section>
    <p class="sec-hdr">Latency Impact</p>
    <div id="latency-wrap">
      <table>
        <thead><tr><th>Endpoint</th><th>p50</th><th>p90</th><th>p99</th></tr></thead>
        <tbody id="latency-body"><tr><td colspan="4" class="placeholder">No latency data.</td></tr></tbody>
      </table>
    </div>
  </section>

  <!-- Section 4: Affected User Journeys -->
  <section>
    <p class="sec-hdr">Affected User Journeys</p>
    <ul id="journeys-list"><li class="placeholder">No journey data.</li></ul>
  </section>

  <!-- Section 5: System Flow Diagram -->
  <section>
    <p class="sec-hdr">System Flow Diagram</p>
    <div id="flow-wrap">
      <svg id="flow-svg" width="100%" height="200" xmlns="http://www.w3.org/2000/svg">
        <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle"
              fill="var(--vscode-descriptionForeground)" font-size="12">
          No flow data available.
        </text>
      </svg>
    </div>
  </section>
</main>

<footer>
  <button class="btn btn-primary"   id="approve-btn">✅ Approve Code as Safe</button>
  <button class="btn btn-secondary" id="changes-btn">✏️ Request Changes</button>
</footer>

<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let trafficChart = null;

  document.getElementById('approve-btn').onclick = () =>
    vscode.postMessage({ type: 'decision', decision: 'approve' });
  document.getElementById('changes-btn').onclick = () =>
    vscode.postMessage({ type: 'decision', decision: 'change' });

  /* ── Data renderers ──────────────────────────────────────────────────────── */

  function renderTests(tests) {
    if (!tests) { return; }
    document.getElementById('cnt-passed').textContent = tests.passed ?? '—';
    document.getElementById('cnt-failed').textContent = tests.failed ?? '—';
    document.getElementById('cnt-total').textContent  = tests.total  ?? '—';
  }

  function renderTraffic(traffic) {
    const placeholder = document.getElementById('chart-placeholder');
    if (!traffic || !traffic.length) { return; }
    placeholder.style.display = 'none';
    const ctx = document.getElementById('traffic-chart').getContext('2d');
    if (trafficChart) { trafficChart.destroy(); }
    trafficChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels:   traffic.map(d => d.endpoint),
        datasets: [
          { label:'Pass', data: traffic.map(d => d.pass), backgroundColor: 'rgba(34,197,94,0.6)' },
          { label:'Fail', data: traffic.map(d => d.fail), backgroundColor: 'rgba(239,68,68,0.6)' },
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

  function renderLatency(latency) {
    if (!latency || !latency.length) { return; }
    const body = document.getElementById('latency-body');
    body.innerHTML = latency.map(r => {
      const p50cls = r.p50after > r.p50before * 1.5 ? 'latency-up' : '';
      const p90cls = r.p90after > r.p90before * 1.5 ? 'latency-up' : '';
      const p99cls = r.p99after > r.p99before * 1.5 ? 'latency-up' : '';
      return '<tr>' +
        '<td>' + esc(r.endpoint) + '</td>' +
        '<td class="' + p50cls + '">' + r.p50before + 'ms → ' + r.p50after + 'ms</td>' +
        '<td class="' + p90cls + '">' + r.p90before + 'ms → ' + r.p90after + 'ms</td>' +
        '<td class="' + p99cls + '">' + r.p99before + 'ms → ' + r.p99after + 'ms</td>' +
        '</tr>';
    }).join('');
  }

  function renderJourneys(journeys) {
    if (!journeys || !journeys.length) { return; }
    const icons = { unaffected: '✅', broken: '🔴', degraded: '🟡' };
    const list  = document.getElementById('journeys-list');
    list.innerHTML = journeys.map(j =>
      '<li>' + (icons[j.status] || '⬜') + ' ' + esc(j.name) + '</li>'
    ).join('');
  }

  function renderFlowDiagram(nodes, edges) {
    const svg = document.getElementById('flow-svg');
    if (!nodes || !nodes.length) { return; }

    svg.innerHTML = '';
    const cols = 4, padX = 20, padY = 20, nodeW = 110, nodeH = 28, gapX = 30, gapY = 20;
    const totalH = Math.ceil(nodes.length / cols) * (nodeH + gapY) + padY * 2;
    svg.setAttribute('height', String(totalH));

    // Position map for edge drawing
    const pos = {};
    nodes.forEach((n, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const cx  = padX + col * (nodeW + gapX) + nodeW / 2;
      const cy  = padY + row * (nodeH + gapY) + nodeH / 2;
      pos[n.id] = { cx, cy };

      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x',      String(cx - nodeW / 2));
      rect.setAttribute('y',      String(cy - nodeH / 2));
      rect.setAttribute('width',  String(nodeW));
      rect.setAttribute('height', String(nodeH));
      rect.setAttribute('rx',     '3');
      rect.setAttribute('fill',   'var(--vscode-button-background)');
      rect.setAttribute('stroke', 'var(--vscode-panel-border)');
      svg.appendChild(rect);

      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x',                String(cx));
      text.setAttribute('y',                String(cy));
      text.setAttribute('text-anchor',      'middle');
      text.setAttribute('dominant-baseline','middle');
      text.setAttribute('fill',             'var(--vscode-button-foreground)');
      text.setAttribute('font-size',        '10');
      text.textContent = n.label;
      svg.appendChild(text);
    });

    (edges || []).forEach(e => {
      const a = pos[e.from], b = pos[e.to];
      if (!a || !b) { return; }
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1',           String(a.cx));
      line.setAttribute('y1',           String(a.cy));
      line.setAttribute('x2',           String(b.cx));
      line.setAttribute('y2',           String(b.cy));
      line.setAttribute('stroke',       'var(--vscode-descriptionForeground)');
      line.setAttribute('stroke-width', '1');
      line.setAttribute('marker-end',   'url(#arrow)');
      svg.insertBefore(line, svg.firstChild);
    });
  }

  /* ── Message handler ─────────────────────────────────────────────────────── */

  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type !== 'updateResults') { return; }
    const d = msg.data || {};
    renderTests(d.tests);
    renderTraffic(d.traffic);
    renderLatency(d.latency);
    renderJourneys(d.journeys);
    renderFlowDiagram(d.flowNodes, d.flowEdges);
  });

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
</script>
</body>
</html>`;
  }
}
