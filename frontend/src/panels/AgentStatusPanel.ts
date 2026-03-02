import * as vscode from 'vscode';
import { getNonce } from '../utils/messageHandler';
import type { SessionStatus } from '../types/agents';

export class AgentStatusPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'runchecks.agentStatus';

  private _view?: vscode.WebviewView;
  private static _instance?: AgentStatusPanel;

  constructor(private readonly _extensionUri: vscode.Uri) {
    AgentStatusPanel._instance = this;
  }

  public static getInstance(): AgentStatusPanel | undefined {
    return AgentStatusPanel._instance;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };
    webviewView.webview.html = this._getHtml();
    webviewView.webview.onDidReceiveMessage(msg => {
      if (msg.type === 'ready') { this._pushIdle(); }
    });
  }

  /** Push a live status update into the webview. */
  public updateStatus(status: SessionStatus): void {
    this._view?.webview.postMessage({ type: 'updateStatus', status });
  }

  /** Reveal the panel (focus sidebar). */
  public focus(): void {
    this._view?.show(true);
  }

  private _pushIdle(): void {
    const idle: SessionStatus = {
      currentStage: '',
      awaitingDecision: false,
      agents: [
        { name: 'orchestrator', status: 'idle' },
        { name: 'parser',       status: 'idle' },
        { name: 'docreader',    status: 'idle' },
        { name: 'reasoner',     status: 'idle' },
        { name: 'factchecker',  status: 'idle' },
        { name: 'attacker',     status: 'idle' },
        { name: 'skeptic',      status: 'idle' },
      ],
    };
    this.updateStatus(idle);
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
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
         color: var(--vscode-foreground); background: transparent; margin: 0; padding: 8px; }
  h3   { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em;
         color: var(--vscode-descriptionForeground); margin: 0 0 8px; }

  .stage-label { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.1em;
                 color: var(--vscode-descriptionForeground); margin: 10px 0 4px; padding: 0 4px; }

  .agent-row { display: flex; align-items: center; gap: 6px;
               padding: 5px 4px; border-radius: 3px; }
  .agent-row:hover { background: var(--vscode-list-hoverBackground); }
  .agent-emoji { font-size: 1rem; width: 20px; text-align: center; flex-shrink: 0; }
  .agent-name  { flex: 1; font-size: 0.82rem; }

  .pill        { font-size: 0.65rem; font-weight: 600; padding: 1px 7px; border-radius: 10px;
                 text-transform: uppercase; letter-spacing: 0.04em; }
  .pill-idle    { background: rgba(128,128,128,0.15); color: var(--vscode-descriptionForeground); }
  .pill-running { background: rgba(0,122,204,0.2);   color: #4fc3f7; }
  .pill-passed  { background: rgba(34,197,94,0.15);  color: #4ade80; }
  .pill-failed  { background: rgba(239,68,68,0.15);  color: #f87171; }

  .gate { display: flex; align-items: center; gap: 5px; margin: 6px 0 6px 28px;
          font-size: 0.75rem; color: #f472b6; font-weight: 600; }

  #session-info { margin-top: 12px; font-size: 0.72rem;
                  color: var(--vscode-descriptionForeground); padding: 0 4px; }
</style>
</head>
<body>
<h3>Agent Pipeline</h3>
<div id="pipeline"></div>
<div id="session-info">No active session.</div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();

  const AGENTS = [
    { id:'orchestrator', label:'Orchestrator', emoji:'🎯',  stage: null      },
    { id:'parser',       label:'Code Parser',  emoji:'⚙️',  stage: null      },
    { id:'docreader',    label:'Doc Reader',   emoji:'📚',  stage: null      },
    { id:'reasoner',     label:'Code Reasoner',emoji:'🧠',  stage: null      },
    { id:'factchecker',  label:'Fact Checker', emoji:'🕵️', stage:'STAGE 1'  },
    { id:'attacker',     label:'Attacker',     emoji:'⚔️',  stage:'STAGE 2'  },
    { id:'skeptic',      label:'Skeptic',      emoji:'🧪',  stage:'STAGE 3 (Optional)' },
  ];

  function cap(s){ return s.charAt(0).toUpperCase() + s.slice(1); }

  function renderPipeline(agentMap, currentStage, awaitingDecision) {
    const container = document.getElementById('pipeline');
    container.innerHTML = '';

    AGENTS.forEach(agent => {
      if (agent.stage) {
        const lbl = document.createElement('div');
        lbl.className = 'stage-label';
        lbl.textContent = '── ' + agent.stage + ' ──';
        container.appendChild(lbl);
      }

      const status = agentMap[agent.id] || 'idle';
      const row = document.createElement('div');
      row.className = 'agent-row';
      row.innerHTML =
        '<span class="agent-emoji">' + agent.emoji + '</span>' +
        '<span class="agent-name">' + agent.label + '</span>' +
        '<span class="pill pill-' + status + '">' + cap(status) + '</span>';
      container.appendChild(row);

      if (awaitingDecision && agent.id === currentStage) {
        const gate = document.createElement('div');
        gate.className = 'gate';
        gate.textContent = '👤 Awaiting your decision';
        container.appendChild(gate);
      }
    });
  }

  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type !== 'updateStatus') { return; }
    const { agents, currentStage, awaitingDecision } = msg.status;
    const map = {};
    (agents || []).forEach(a => { map[a.name] = a.status; });
    renderPipeline(map, currentStage, awaitingDecision);
    document.getElementById('session-info').textContent =
      awaitingDecision ? 'Awaiting decision: ' + currentStage :
      currentStage     ? 'Running: ' + currentStage :
                         'No active session.';
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
