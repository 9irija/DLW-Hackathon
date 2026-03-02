/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ([
/* 0 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(__webpack_require__(1));
const AgentStatusPanel_1 = __webpack_require__(2);
const SetupPanel_1 = __webpack_require__(4);
const FindingsPanel_1 = __webpack_require__(5);
const client = __importStar(__webpack_require__(7));
const highlighter_1 = __webpack_require__(6);
// ─── Module state ─────────────────────────────────────────────────────────────
let statusBarItem;
let agentStatusPanel;
let currentSessionId;
let currentFilePath;
let _context;
// Per-agent live state fed to the sidebar panel
const _agentStates = {
    orchestrator: 'idle', parser: 'idle', docreader: 'idle', reasoner: 'idle',
    factchecker: 'idle', attacker: 'idle', skeptic: 'idle',
};
// ─── Activate ─────────────────────────────────────────────────────────────────
function activate(context) {
    _context = context;
    // ── Status bar ──────────────────────────────────────────────────────────────
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.text = '$(shield) RunChecks';
    statusBarItem.tooltip = 'Click to show agent pipeline';
    statusBarItem.command = 'runchecks.showStatus';
    context.subscriptions.push(statusBarItem);
    // ── Sidebar WebviewView provider ────────────────────────────────────────────
    const agentStatusProvider = new AgentStatusPanel_1.AgentStatusPanel(context.extensionUri);
    agentStatusPanel = agentStatusProvider;
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(AgentStatusPanel_1.AgentStatusPanel.viewType, agentStatusProvider));
    // ── Wire panel decision callback ─────────────────────────────────────────────
    FindingsPanel_1.FindingsPanel.onDecision = _handleFindingsDecision;
    SetupPanel_1.SetupPanel.onStartSession = () => _startReview(true);
    // ── Commands ────────────────────────────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('runchecks.startReview', () => _startReview(false)), vscode.commands.registerCommand('runchecks.startReviewWithDocs', async () => {
        if (!SetupPanel_1.uploadedDocs.length) {
            SetupPanel_1.SetupPanel.show(context.extensionUri);
            vscode.window.showInformationMessage('RunChecks: No documents loaded. Use "Setup & Documents" to upload docs, then run "Run RunChecks Review (with Docs)".');
            return;
        }
        await _startReview(true);
    }), vscode.commands.registerCommand('runchecks.openSetup', () => {
        SetupPanel_1.SetupPanel.show(context.extensionUri);
    }), vscode.commands.registerCommand('runchecks.showStatus', () => {
        agentStatusProvider.focus();
        vscode.commands.executeCommand('runchecks.agentStatus.focus');
    }));
    vscode.window.showInformationMessage('RunChecks is active. Highlight code and right-click → "🔍 Run RunChecks Review".');
}
// ─── Deactivate ───────────────────────────────────────────────────────────────
function deactivate() {
    (0, highlighter_1.clearHighlights)();
}
// ─── Agent status helpers ─────────────────────────────────────────────────────
function _pushStatus(currentStage, awaitingDecision) {
    if (!agentStatusPanel) {
        return;
    }
    const sessionStatus = {
        currentStage,
        awaitingDecision,
        agents: Object.entries(_agentStates).map(([name, status]) => ({ name, status })),
    };
    agentStatusPanel.updateStatus(sessionStatus);
}
function _resetAllAgentStates() {
    Object.keys(_agentStates).forEach(k => { _agentStates[k] = 'idle'; });
    _pushStatus('', false);
}
// ─── Review flow ──────────────────────────────────────────────────────────────
async function _startReview(useDocs) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('RunChecks: Open a file first.');
        return;
    }
    const sel = editor.selection;
    const code = sel.isEmpty ? editor.document.getText() : editor.document.getText(sel);
    const filePath = editor.document.fileName;
    const lineStart = sel.isEmpty ? 1 : sel.start.line + 1;
    const lineEnd = sel.isEmpty ? editor.document.lineCount : sel.end.line + 1;
    (0, highlighter_1.clearHighlights)();
    currentSessionId = undefined;
    currentFilePath = filePath;
    // Reset and show pipeline immediately
    _resetAllAgentStates();
    vscode.commands.executeCommand('runchecks.showStatus');
    // Mark pre-processing agents as running
    _agentStates['orchestrator'] = 'running';
    _agentStates['parser'] = 'running';
    _agentStates['reasoner'] = 'running';
    _pushStatus('parser', false);
    statusBarItem.text = '$(sync~spin) RunChecks — Pre-processing…';
    statusBarItem.show();
    try {
        let startResult;
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'RunChecks: Parsing & reasoning…', cancellable: false }, async () => {
            startResult = await client.startReview(code, filePath, lineStart, lineEnd, useDocs ? SetupPanel_1.uploadedDocs : undefined);
        });
        currentSessionId = startResult.sessionId;
        _agentStates['parser'] = 'passed';
        _agentStates['reasoner'] = 'passed';
        _pushStatus('', true);
        statusBarItem.text = '$(shield) RunChecks — Pre-processing complete';
        const pick = await vscode.window.showInformationMessage('✅ RunChecks: Pre-processing complete. Ready to run Fact Checker.', 'Run Fact Checker', 'Stop');
        if (pick !== 'Run Fact Checker') {
            _resetAllAgentStates();
            _resetStatusBar();
            return;
        }
        await _runAgent('factchecker');
    }
    catch (err) {
        _agentStates['parser'] = 'failed';
        _agentStates['reasoner'] = 'failed';
        _pushStatus('', false);
        _resetStatusBar();
        vscode.window.showErrorMessage(`RunChecks: Failed to start — ${err.message}`);
    }
}
async function _runAgent(agent) {
    if (!currentSessionId) {
        return;
    }
    _agentStates[agent] = 'running';
    // Factchecker runs docreader internally when docs are present; show docreader in pipeline
    if (agent === 'factchecker') {
        _agentStates['docreader'] = 'running';
    }
    _pushStatus(agent, false);
    statusBarItem.text = `$(sync~spin) RunChecks — Running ${agent}…`;
    try {
        let nextResult;
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `RunChecks: Running ${agent}…`, cancellable: false }, async () => { nextResult = await client.runNextAgent(currentSessionId, agent); });
        const passed = nextResult.agentResult?.['status'] === 'pass';
        _agentStates[agent] = passed ? 'passed' : 'failed';
        if (agent === 'factchecker') {
            _agentStates['docreader'] = passed ? 'passed' : 'failed';
        }
        _pushStatus(agent, true);
        const adapted = _adaptAgentResult(nextResult.agentResult, agent);
        FindingsPanel_1.FindingsPanel.show(_context.extensionUri, adapted);
        statusBarItem.text = `$(shield) RunChecks — ${agent} complete`;
    }
    catch (err) {
        _agentStates[agent] = 'failed';
        _pushStatus(agent, false);
        _resetStatusBar();
        vscode.window.showErrorMessage(`RunChecks: ${agent} failed — ${err.message}`);
    }
}
async function _runSkeptic() {
    if (!currentSessionId) {
        return;
    }
    _agentStates['skeptic'] = 'running';
    _pushStatus('skeptic', false);
    statusBarItem.text = '$(sync~spin) RunChecks — Running Skeptic…';
    try {
        let nextResult;
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'RunChecks: Running Skeptic…', cancellable: false }, async () => { nextResult = await client.runNextAgent(currentSessionId, 'skeptic'); });
        const passed = nextResult.agentResult?.['status'] === 'pass';
        _agentStates['skeptic'] = passed ? 'passed' : 'failed';
        _pushStatus('skeptic', true);
        // Show skeptic results in the same FindingsPanel tab (no new tab)
        FindingsPanel_1.FindingsPanel.showSkeptic(_context.extensionUri, nextResult.agentResult);
        statusBarItem.text = '$(shield) RunChecks — Skeptic complete';
    }
    catch (err) {
        _agentStates['skeptic'] = 'failed';
        _pushStatus('skeptic', false);
        _resetStatusBar();
        vscode.window.showErrorMessage(`RunChecks: Skeptic failed — ${err.message}`);
    }
}
async function _finalizeReview() {
    if (!currentSessionId) {
        return;
    }
    _agentStates['orchestrator'] = 'running';
    _pushStatus('orchestrator', false);
    try {
        let finalResult;
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'RunChecks: Computing verdict…', cancellable: false }, async () => { finalResult = await client.finalizeReview(currentSessionId); });
        currentSessionId = undefined;
        _agentStates['orchestrator'] = 'passed';
        _pushStatus('', false);
        // Show final verdict page in the same panel
        FindingsPanel_1.FindingsPanel.showVerdict(_context.extensionUri, finalResult);
        const { verdict, score } = finalResult;
        const icon = verdict === 'APPROVE' ? '✅' : verdict === 'BLOCK' ? '🚫' : '⚠️';
        statusBarItem.text = `${icon} RunChecks — ${verdict} (${score}/100)`;
    }
    catch (err) {
        _agentStates['orchestrator'] = 'failed';
        _pushStatus('', false);
        vscode.window.showErrorMessage(`RunChecks: Finalize failed — ${err.message}`);
        _resetStatusBar();
    }
}
// ─── Panel decision handler ────────────────────────────────────────────────────
async function _handleFindingsDecision(stage, decision) {
    if (decision === 'change') {
        vscode.window.showInformationMessage('RunChecks: Review stopped. Address the findings and run again.');
        _resetAllAgentStates();
        _resetStatusBar();
        return;
    }
    // decision === 'approve'
    if (stage === 'factchecker') {
        await _runAgent('attacker');
    }
    else if (stage === 'attacker') {
        const pick = await vscode.window.showInformationMessage('Attacker stage complete. Optionally run Skeptic shadow analysis, or finalize now.', { modal: true }, 'Run Skeptic', 'Finalize Now');
        if (pick === 'Run Skeptic') {
            await _runSkeptic();
        }
        else if (pick === 'Finalize Now') {
            await _finalizeReview();
        }
        // pick === undefined means user pressed Escape/X — stay on current panel, do nothing
    }
    else if (stage === 'skeptic') {
        await _finalizeReview();
    }
    else {
        // pre-processing stage
        await _runAgent('factchecker');
    }
}
// ─── Helpers ──────────────────────────────────────────────────────────────────
function _resetStatusBar() {
    statusBarItem.text = '$(shield) RunChecks';
}
/** Maps raw backend agent output → the TypeScript AgentResult shape FindingsPanel expects. */
function _adaptAgentResult(raw, agent) {
    const rawFindings = raw['findings'] ?? [];
    const findings = rawFindings.map(f => ({
        type: String(f['type'] ?? f['category'] ?? 'issue'),
        severity: (['critical', 'high', 'medium', 'low'].includes(String(f['severity']))
            ? f['severity'] : 'low'),
        file: String(f['filePath'] ?? f['file'] ?? currentFilePath ?? ''),
        line: Number(f['line'] ?? 0),
        description: String(f['description'] ?? f['claim'] ?? ''),
        suggestion: String(f['suggestion'] ?? ''),
    }));
    return {
        agentName: String(raw['agent'] ?? agent),
        stage: agent,
        passed: raw['status'] === 'pass',
        findings,
        summary: raw['summary'] ? String(raw['summary']) : undefined,
    };
}


/***/ }),
/* 1 */
/***/ ((module) => {

module.exports = require("vscode");

/***/ }),
/* 2 */
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.AgentStatusPanel = void 0;
const messageHandler_1 = __webpack_require__(3);
class AgentStatusPanel {
    constructor(_extensionUri) {
        this._extensionUri = _extensionUri;
        AgentStatusPanel._instance = this;
    }
    static getInstance() {
        return AgentStatusPanel._instance;
    }
    resolveWebviewView(webviewView, _context, _token) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };
        webviewView.webview.html = this._getHtml();
        webviewView.webview.onDidReceiveMessage(msg => {
            if (msg.type === 'ready') {
                this._pushIdle();
            }
        });
    }
    /** Push a live status update into the webview. */
    updateStatus(status) {
        this._view?.webview.postMessage({ type: 'updateStatus', status });
    }
    /** Reveal the panel (focus sidebar). */
    focus() {
        this._view?.show(true);
    }
    _pushIdle() {
        const idle = {
            currentStage: '',
            awaitingDecision: false,
            agents: [
                { name: 'orchestrator', status: 'idle' },
                { name: 'parser', status: 'idle' },
                { name: 'docreader', status: 'idle' },
                { name: 'reasoner', status: 'idle' },
                { name: 'factchecker', status: 'idle' },
                { name: 'attacker', status: 'idle' },
                { name: 'skeptic', status: 'idle' },
            ],
        };
        this.updateStatus(idle);
    }
    _getHtml() {
        const nonce = (0, messageHandler_1.getNonce)();
        return /* html */ `<!DOCTYPE html>
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
exports.AgentStatusPanel = AgentStatusPanel;
AgentStatusPanel.viewType = 'runchecks.agentStatus';


/***/ }),
/* 3 */
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.getNonce = getNonce;
exports.escHtml = escHtml;
/** Generate a cryptographically adequate nonce for webview CSP. */
function getNonce() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) {
        nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
}
/** Escape a string for safe insertion into HTML. */
function escHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}


/***/ }),
/* 4 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.SetupPanel = exports.uploadedDocs = void 0;
const vscode = __importStar(__webpack_require__(1));
const messageHandler_1 = __webpack_require__(3);
/** Docs uploaded in the setup panel are kept here for use by the review flow. */
exports.uploadedDocs = [];
class SetupPanel {
    constructor(panel, _extUri) {
        this._extUri = _extUri;
        this._panel_ = panel;
        panel.webview.options = { enableScripts: true, localResourceRoots: [_extUri] };
        panel.webview.html = this._getHtml();
        panel.webview.onDidReceiveMessage(msg => this._handleMessage(msg));
        panel.onDidDispose(() => { SetupPanel._panel = undefined; });
    }
    static show(extensionUri) {
        if (SetupPanel._panel) {
            SetupPanel._panel._panel_.reveal(vscode.ViewColumn.Active);
        }
        else {
            const panel = vscode.window.createWebviewPanel(SetupPanel.viewType, 'RunChecks — Setup', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
            SetupPanel._panel = new SetupPanel(panel, extensionUri);
        }
        SetupPanel._panel._refreshDocs();
    }
    _refreshDocs() {
        const docs = exports.uploadedDocs.map(d => ({
            filename: d.name,
            uploadedAt: new Date().toISOString(),
            chunks: Math.ceil(d.content.length / 1000),
        }));
        this._panel_.webview.postMessage({ type: 'updateDocs', docs });
    }
    _handleMessage(msg) {
        if (msg.type === 'uploadDoc') {
            exports.uploadedDocs = exports.uploadedDocs.filter(d => d.name !== msg.name);
            exports.uploadedDocs.push({ name: msg.name, content: msg.content });
            vscode.window.showInformationMessage(`RunChecks: "${msg.name}" loaded. It will be included in the next review.`);
            this._refreshDocs();
        }
        if (msg.type === 'deleteDoc') {
            exports.uploadedDocs = exports.uploadedDocs.filter(d => d.name !== msg.name);
            vscode.window.showInformationMessage(`RunChecks: "${msg.name}" removed from this session.`);
            this._refreshDocs();
        }
        if (msg.type === 'startSession') {
            void Promise.resolve(SetupPanel.onStartSession?.()).catch(err => vscode.window.showErrorMessage(`RunChecks: Failed to start review — ${err.message}`));
        }
    }
    _getHtml() {
        const nonce = (0, messageHandler_1.getNonce)();
        return /* html */ `<!DOCTYPE html>
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
exports.SetupPanel = SetupPanel;
SetupPanel.viewType = 'runchecks.setup';


/***/ }),
/* 5 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.FindingsPanel = void 0;
const vscode = __importStar(__webpack_require__(1));
const messageHandler_1 = __webpack_require__(3);
const highlighter_1 = __webpack_require__(6);
class FindingsPanel {
    constructor(panel, _extUri) {
        this._extUri = _extUri;
        this._panel_ = panel;
        panel.webview.options = { enableScripts: true, localResourceRoots: [_extUri] };
        panel.webview.onDidReceiveMessage(msg => this._handleMessage(msg));
        panel.onDidDispose(() => { FindingsPanel._panel = undefined; });
    }
    // ─── Shared panel factory ──────────────────────────────────────────────────
    static _getOrCreate(extensionUri) {
        if (FindingsPanel._panel) {
            // Reveal with focus so the tab comes to the front
            FindingsPanel._panel._panel_.reveal(vscode.ViewColumn.Active, false);
            return FindingsPanel._panel;
        }
        const panel = vscode.window.createWebviewPanel(FindingsPanel.viewType, 'RunChecks — Findings', { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, { enableScripts: true, retainContextWhenHidden: true });
        FindingsPanel._panel = new FindingsPanel(panel, extensionUri);
        return FindingsPanel._panel;
    }
    // ─── Public entry points ───────────────────────────────────────────────────
    /** Show per-agent findings (factchecker / attacker). */
    static show(extensionUri, result) {
        const fp = FindingsPanel._getOrCreate(extensionUri);
        if (result) {
            fp._renderFindings(result);
        }
    }
    /** Show Skeptic analysis results in the same tab. */
    static showSkeptic(extensionUri, raw) {
        const fp = FindingsPanel._getOrCreate(extensionUri);
        fp._panel_.title = 'RunChecks — Skeptic Analysis';
        fp._panel_.webview.html = fp._getSkepticHtml(raw);
    }
    /** Show the final verdict page. */
    static showVerdict(extensionUri, data) {
        const fp = FindingsPanel._getOrCreate(extensionUri);
        fp._panel_.title = 'RunChecks — Final Verdict';
        fp._panel_.webview.html = fp._getVerdictHtml(data);
    }
    // ─── Internal renderers ────────────────────────────────────────────────────
    _renderFindings(result) {
        this._panel_.title = `RunChecks — ${result.agentName} Findings`;
        this._panel_.webview.html = this._getFindingsHtml(result);
        // Highlight finding lines in the editor
        const bySeverity = new Map();
        for (const f of result.findings) {
            if (!bySeverity.has(f.severity)) {
                bySeverity.set(f.severity, []);
            }
            bySeverity.get(f.severity).push(f.line);
        }
        bySeverity.forEach((lines, sev) => {
            (0, highlighter_1.highlightLines)(result.findings[0]?.file ?? '', lines, sev)
                .catch(() => { });
        });
    }
    async _handleMessage(msg) {
        if (msg.type === 'decision') {
            FindingsPanel.onDecision?.(msg.stage, msg.decision);
        }
        if (msg.type === 'jumpToLine') {
            try {
                await (0, highlighter_1.jumpToLine)(msg.file, msg.line);
            }
            catch { /* ignore */ }
        }
        if (msg.type === 'close') {
            FindingsPanel._panel?._panel_.dispose();
        }
    }
    // ─── HTML: Findings ────────────────────────────────────────────────────────
    _getFindingsHtml(result) {
        const nonce = (0, messageHandler_1.getNonce)();
        const stageMap = {
            'pre-processing': 'Pre-processing — Parser & Reasoner',
            factchecker: 'Stage 1 — Compliance & Hallucination',
            attacker: 'Stage 2 — Security',
            skeptic: 'Stage 3 — Shadow Execution',
        };
        const stageLabel = stageMap[result.stage] ?? result.stage;
        const findingRows = result.findings.length
            ? result.findings.map(f => _findingCardHtml(f)).join('')
            : '<div class="all-clear">✅ All Clear — No issues found.</div>';
        const summaryHtml = result.summary
            ? `<div class="summary-box">
           <div class="summary-title">Agent summary</div>
           <div class="summary-meta">
             <span>${escHtml(result.agentName)}</span>
             <span class="dot">•</span>
             <span>${escHtml(stageLabel)}</span>
             <span class="dot">•</span>
             <span>${result.findings.length} finding(s)</span>
             <span class="dot">•</span>
             <span>${result.passed ? 'Status: passed (no blockers)' : 'Status: issues found'}</span>
           </div>
           <div class="summary-body">${escHtml(result.summary)}</div>
         </div>`
            : '';
        return /* html */ `<!DOCTYPE html>
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
    _getSkepticHtml(raw) {
        const nonce = (0, messageHandler_1.getNonce)();
        const evidence = raw['evidence'];
        const directTests = raw['tests'];
        const tests = directTests ?? (evidence?.failureTimeline
            ? {
                passed: evidence.failureTimeline.filter(p => p.passed).length,
                failed: evidence.failureTimeline.filter(p => p.failed).length,
                total: evidence.failureTimeline.length,
            }
            : undefined);
        const directTraffic = raw['traffic'];
        const traffic = directTraffic ?? (evidence?.endpointHeatmap
            ? evidence.endpointHeatmap.map(e => ({
                endpoint: String(e.endpoint ?? ''),
                pass: Number(e.passed ?? 0),
                fail: Number(e.failed ?? 0),
            }))
            : undefined);
        const directLatency = raw['latency'];
        const latency = directLatency ?? (evidence?.latencyDistribution
            ? (() => {
                const before = evidence.latencyDistribution.before ?? [];
                const after = evidence.latencyDistribution.after ?? [];
                if (!before.length && !after.length)
                    return undefined;
                const p = (vals, q) => _percentile(vals, q);
                return [{
                        endpoint: 'overall',
                        p50before: before.length ? p(before, 0.5) : 0,
                        p50after: after.length ? p(after, 0.5) : 0,
                        p90before: before.length ? p(before, 0.9) : 0,
                        p90after: after.length ? p(after, 0.9) : 0,
                        p99before: before.length ? p(before, 0.99) : 0,
                        p99after: after.length ? p(after, 0.99) : 0,
                    }];
            })()
            : undefined);
        const directJourneys = raw['journeys'];
        const journeys = directJourneys ?? (evidence?.userJourneyFailures
            ? evidence.userJourneyFailures.map(j => ({
                name: String(j.name ?? 'Unknown journey'),
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
        // Inline traffic data so Chart.js renders immediately without a postMessage race
        const trafficJson = JSON.stringify(traffic ?? []);
        const hasTraffic = (traffic && traffic.length) ? 'true' : 'false';
        return /* html */ `<!DOCTYPE html>
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
    _getVerdictHtml(data) {
        const nonce = (0, messageHandler_1.getNonce)();
        const verdict = String(data.verdict ?? 'UNKNOWN');
        const score = Number(data.score ?? 0);
        const findings = (data.prioritizedFindings ?? []);
        const verdictColor = verdict === 'APPROVE' ? '#4ade80' :
            verdict === 'BLOCK' ? '#ef4444' :
                verdict === 'REQUEST CHANGES' ? '#f97316' : '#94a3b8';
        const verdictIcon = verdict === 'APPROVE' ? '✅' :
            verdict === 'BLOCK' ? '🚫' :
                verdict === 'REQUEST CHANGES' ? '⚠️' : '❓';
        const sevCount = { critical: 0, high: 0, medium: 0, low: 0 };
        for (const f of findings) {
            const sev = String(f['severity'] ?? '').toLowerCase();
            if (sev in sevCount) {
                sevCount[sev]++;
            }
        }
        const groupedHtml = findings.length
            ? (() => {
                const byAgent = new Map();
                for (const f of findings) {
                    const agentKey = String(f['agent'] ??
                        f['agentName'] ??
                        f['source'] ??
                        'other').toLowerCase();
                    if (!byAgent.has(agentKey))
                        byAgent.set(agentKey, []);
                    byAgent.get(agentKey).push(f);
                }
                const order = ['factchecker', 'attacker', 'skeptic'];
                const labels = {
                    factchecker: 'Fact Checker',
                    attacker: 'Attacker',
                    skeptic: 'Skeptic',
                };
                const orderedKeys = [
                    ...order.filter(k => byAgent.has(k)),
                    ...Array.from(byAgent.keys()).filter(k => !order.includes(k)),
                ];
                return orderedKeys.map(agentKey => {
                    const agentFindings = byAgent.get(agentKey);
                    const title = labels[agentKey] ?? (agentKey ? agentKey : 'Other');
                    const cards = agentFindings.map(f => {
                        const sev = String(f['severity'] ?? 'low').toLowerCase();
                        const desc = String(f['description'] ?? f['claim'] ?? '');
                        const sugg = String(f['suggestion'] ?? '');
                        return `<div class="finding-card">
  <div class="finding-header">
    <span class="sev sev-${escHtml(sev)}">${escHtml(sev)}</span>
    <span class="agent-chip">${escHtml(title)}</span>
  </div>
  <div class="finding-desc"><span class="label">Finding:</span> ${escHtml(desc)}</div>
  ${sugg ? `<div class="finding-suggestion"><span class="label">💡 Suggestion:</span> ${escHtml(sugg)}</div>` : ''}
</div>`;
                    }).join('');
                    return `<section class="agent-section">
  <h3 class="agent-section-title">${escHtml(title)} findings</h3>
  ${cards}
</section>`;
                }).join('');
            })()
            : '<div class="all-clear">✅ No findings — code is clean.</div>';
        return /* html */ `<!DOCTYPE html>
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
</script>
</body>
</html>`;
    }
}
exports.FindingsPanel = FindingsPanel;
FindingsPanel.viewType = 'runchecks.findings';
// ─── Module-level helpers ──────────────────────────────────────────────────────
function escHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function _commonStyles() {
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
                  margin-bottom: 4px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .summary-meta .dot { opacity: 0.6; }
  .summary-body { font-size: 0.8rem; }

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
function _findingCardHtml(f) {
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
function _percentile(values, p) {
    if (!values.length)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = (sorted.length - 1) * p;
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);
    if (lower === upper)
        return sorted[lower];
    const weight = idx - lower;
    return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}


/***/ }),
/* 6 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.highlightLines = highlightLines;
exports.clearHighlights = clearHighlights;
exports.jumpToLine = jumpToLine;
const vscode = __importStar(__webpack_require__(1));
const COLOURS = {
    critical: '#ef4444',
    high: '#f97316',
    medium: '#eab308',
    low: '#3b82f6',
};
/** One decoration type per severity — created once, reused. */
const decorationTypes = {};
function getDecorationType(severity) {
    if (!decorationTypes[severity]) {
        const colour = COLOURS[severity];
        decorationTypes[severity] = vscode.window.createTextEditorDecorationType({
            borderWidth: '0 0 0 3px',
            borderStyle: 'solid',
            borderColor: colour,
            gutterIconPath: _makeGutterIcon(colour),
            gutterIconSize: '70%',
            overviewRulerColor: colour,
            overviewRulerLane: vscode.OverviewRulerLane.Left,
            isWholeLine: true,
        });
    }
    return decorationTypes[severity];
}
/**
 * Highlight specific line numbers in the given file.
 * Lines are 1-based.
 */
async function highlightLines(filePath, lineNumbers, severity) {
    const uri = vscode.Uri.file(filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
    const ranges = lineNumbers
        .filter(n => n >= 1 && n <= doc.lineCount)
        .map(n => new vscode.Range(n - 1, 0, n - 1, doc.lineAt(n - 1).text.length));
    editor.setDecorations(getDecorationType(severity), ranges);
}
/** Remove all RunChecks decorations from all editors. */
function clearHighlights() {
    const editors = vscode.window.visibleTextEditors;
    for (const severity of Object.keys(decorationTypes)) {
        const dt = decorationTypes[severity];
        if (dt) {
            editors.forEach(e => e.setDecorations(dt, []));
        }
    }
}
/** Open a file and scroll to the given line (1-based). */
async function jumpToLine(filePath, lineNumber) {
    const uri = vscode.Uri.file(filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const line = Math.max(0, lineNumber - 1);
    const pos = new vscode.Position(line, 0);
    await vscode.window.showTextDocument(doc, {
        selection: new vscode.Range(pos, pos),
        preview: false,
    });
}
// ─── Internal helpers ─────────────────────────────────────────────────────────
function _makeGutterIcon(colour) {
    // Inline SVG circle as a data URI for the gutter icon
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="${colour}"/></svg>`;
    return vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
}


/***/ }),
/* 7 */
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.startReview = startReview;
exports.runNextAgent = runNextAgent;
exports.finalizeReview = finalizeReview;
exports.checkHealth = checkHealth;
const http = __importStar(__webpack_require__(8));
const https = __importStar(__webpack_require__(9));
const vscode = __importStar(__webpack_require__(1));
function getBaseUrl() {
    return vscode.workspace.getConfiguration('runchecks').get('backendUrl', 'http://127.0.0.1:3001');
}
function request(method, path, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : undefined;
        const rawUrl = `${getBaseUrl()}${path}`;
        let url;
        try {
            url = new URL(rawUrl);
        }
        catch {
            return reject(new Error(`Invalid URL: ${rawUrl}`));
        }
        const lib = url.protocol === 'https:' ? https : http;
        const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
        const headers = { 'Content-Type': 'application/json' };
        if (data) {
            headers['Content-Length'] = Buffer.byteLength(data);
        }
        const req = lib.request({ hostname: url.hostname, port, path: url.pathname + url.search, method, headers }, res => {
            let raw = '';
            res.on('data', chunk => { raw += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(raw || '{}'));
                }
                catch {
                    reject(new Error('Invalid JSON from backend'));
                }
            });
        });
        req.on('error', reject);
        if (data) {
            req.write(data);
        }
        req.end();
    });
}
// ─── API functions ─────────────────────────────────────────────────────────────
/** Strip data URL prefix so backend gets raw base64 (docreader expects that for PDF/docx). */
function normalizeDocContent(doc) {
    const c = doc.content;
    if (typeof c !== 'string' || !c.startsWith('data:'))
        return doc;
    const comma = c.indexOf(',');
    if (comma === -1)
        return doc;
    return { name: doc.name, content: c.slice(comma + 1).trim() };
}
/** POST /review/start — runs pre-processing pipeline, returns sessionId + checkpoint */
function startReview(code, filePath, lineStart, lineEnd, docs) {
    const payload = { code, filePath, lineStart, lineEnd };
    if (docs && docs.length) {
        payload.docs = docs.map(normalizeDocContent);
    }
    return request('POST', '/review/start', payload);
}
/** POST /review/next — runs factchecker, attacker, or skeptic for an existing session */
function runNextAgent(sessionId, agent) {
    return request('POST', '/review/next', { sessionId, agent });
}
/** POST /review/finalize — computes final verdict from all collected results */
function finalizeReview(sessionId) {
    return request('POST', '/review/finalize', { sessionId });
}
/** GET /health — liveness check */
function checkHealth() {
    return request('GET', '/health');
}


/***/ }),
/* 8 */
/***/ ((module) => {

module.exports = require("http");

/***/ }),
/* 9 */
/***/ ((module) => {

module.exports = require("https");

/***/ })
/******/ 	]);
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		__webpack_modules__[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	// This entry module is referenced by other modules so it can't be inlined
/******/ 	var __webpack_exports__ = __webpack_require__(0);
/******/ 	module.exports = __webpack_exports__;
/******/ 	
/******/ })()
;
//# sourceMappingURL=extension.js.map