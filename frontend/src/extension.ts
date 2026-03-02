import * as vscode from 'vscode';
import { AgentStatusPanel }          from './panels/AgentStatusPanel';
import { SetupPanel, uploadedDocs }  from './panels/SetupPanel';
import { FindingsPanel }             from './panels/FindingsPanel';
import * as client                   from './utils/backendClient';
import { clearHighlights }           from './utils/highlighter';
import type { AgentResult, AgentFinding, SessionStatus } from './types/agents';

// ─── Module state ─────────────────────────────────────────────────────────────

let statusBarItem:    vscode.StatusBarItem;
let agentStatusPanel: AgentStatusPanel | undefined;
let currentSessionId: string | undefined;
let currentFilePath:  string | undefined;
let _context:         vscode.ExtensionContext;

// Per-agent live state fed to the sidebar panel
const _agentStates: Record<string, 'idle'|'running'|'passed'|'failed'> = {
  orchestrator: 'idle', parser: 'idle', docreader: 'idle', reasoner: 'idle',
  factchecker:  'idle', attacker: 'idle', skeptic: 'idle',
};

// ─── Activate ─────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  _context = context;

  // ── Status bar ──────────────────────────────────────────────────────────────
  statusBarItem         = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text    = '$(shield) RunChecks';
  statusBarItem.tooltip = 'Click to show agent pipeline';
  statusBarItem.command = 'runchecks.showStatus';
  context.subscriptions.push(statusBarItem);

  // ── Sidebar WebviewView provider ────────────────────────────────────────────
  const agentStatusProvider = new AgentStatusPanel(context.extensionUri);
  agentStatusPanel = agentStatusProvider;
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AgentStatusPanel.viewType, agentStatusProvider)
  );

  // ── Wire panel decision callback ─────────────────────────────────────────────
  FindingsPanel.onDecision = _handleFindingsDecision;
  SetupPanel.onStartSession = () => _startReview(true);

  // ── Commands ────────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('runchecks.startReview', () => _startReview(false)),
    vscode.commands.registerCommand('runchecks.startReviewWithDocs', async () => {
      if (!uploadedDocs.length) {
        SetupPanel.show(context.extensionUri);
        vscode.window.showInformationMessage(
          'RunChecks: No documents loaded. Use "Setup & Documents" to upload docs, then run "Run RunChecks Review (with Docs)".'
        );
        return;
      }
      await _startReview(true);
    }),
    vscode.commands.registerCommand('runchecks.openSetup', () => {
      SetupPanel.show(context.extensionUri);
    }),
    vscode.commands.registerCommand('runchecks.showStatus', () => {
      agentStatusProvider.focus();
      vscode.commands.executeCommand('runchecks.agentStatus.focus');
    })
  );

  vscode.window.showInformationMessage(
    'RunChecks is active. Highlight code and right-click → "🔍 Run RunChecks Review".'
  );
}

// ─── Deactivate ───────────────────────────────────────────────────────────────

export function deactivate(): void {
  clearHighlights();
}

// ─── Agent status helpers ─────────────────────────────────────────────────────

function _pushStatus(currentStage: string, awaitingDecision: boolean): void {
  if (!agentStatusPanel) { return; }
  const sessionStatus: SessionStatus = {
    currentStage,
    awaitingDecision,
    agents: Object.entries(_agentStates).map(([name, status]) => ({ name, status })),
  };
  agentStatusPanel.updateStatus(sessionStatus);
}

function _resetAllAgentStates(): void {
  (Object.keys(_agentStates) as string[]).forEach(k => { _agentStates[k] = 'idle'; });
  _pushStatus('', false);
}

// ─── Review flow ──────────────────────────────────────────────────────────────

async function _startReview(useDocs: boolean): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('RunChecks: Open a file first.');
    return;
  }

  const sel       = editor.selection;
  const code      = sel.isEmpty ? editor.document.getText() : editor.document.getText(sel);
  const filePath  = editor.document.fileName;
  const lineStart = sel.isEmpty ? 1 : sel.start.line + 1;
  const lineEnd   = sel.isEmpty ? editor.document.lineCount : sel.end.line + 1;

  clearHighlights();
  currentSessionId = undefined;
  currentFilePath  = filePath;

  // Reset and show pipeline immediately
  _resetAllAgentStates();
  vscode.commands.executeCommand('runchecks.showStatus');

  // Mark pre-processing agents as running
  _agentStates['orchestrator'] = 'running';
  _agentStates['parser']       = 'running';
  _agentStates['reasoner']     = 'running';
  _pushStatus('parser', false);

  statusBarItem.text = '$(sync~spin) RunChecks — Pre-processing…';
  statusBarItem.show();

  try {
    let startResult!: client.StartReviewResponse;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'RunChecks: Parsing & reasoning…', cancellable: false },
      async () => {
        startResult = await client.startReview(
          code,
          filePath,
          lineStart,
          lineEnd,
          useDocs ? uploadedDocs : undefined
        );
      }
    );

    currentSessionId = startResult.sessionId;

    _agentStates['parser']   = 'passed';
    _agentStates['reasoner'] = 'passed';
    _pushStatus('', true);

    statusBarItem.text = '$(shield) RunChecks — Pre-processing complete';

    const pick = await vscode.window.showInformationMessage(
      '✅ RunChecks: Pre-processing complete. Ready to run Fact Checker.',
      'Run Fact Checker',
      'Stop'
    );

    if (pick !== 'Run Fact Checker') {
      _resetAllAgentStates();
      _resetStatusBar();
      return;
    }

    await _runAgent('factchecker');

  } catch (err) {
    _agentStates['parser']   = 'failed';
    _agentStates['reasoner'] = 'failed';
    _pushStatus('', false);
    _resetStatusBar();
    vscode.window.showErrorMessage(`RunChecks: Failed to start — ${(err as Error).message}`);
  }
}

async function _runAgent(agent: string): Promise<void> {
  if (!currentSessionId) { return; }

  _agentStates[agent] = 'running';
  // Factchecker runs docreader internally when docs are present; show docreader in pipeline
  if (agent === 'factchecker') {
    _agentStates['docreader'] = 'running';
  }
  _pushStatus(agent, false);
  statusBarItem.text = `$(sync~spin) RunChecks — Running ${agent}…`;

  try {
    let nextResult!: client.NextAgentResponse;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `RunChecks: Running ${agent}…`, cancellable: false },
      async () => { nextResult = await client.runNextAgent(currentSessionId!, agent); }
    );

    const passed = nextResult.agentResult?.['status'] === 'pass';
    _agentStates[agent] = passed ? 'passed' : 'failed';
    if (agent === 'factchecker') {
      _agentStates['docreader'] = passed ? 'passed' : 'failed';
    }
    _pushStatus(agent, true);

    const adapted = _adaptAgentResult(nextResult.agentResult, agent);
    FindingsPanel.show(_context.extensionUri, adapted);
    statusBarItem.text = `$(shield) RunChecks — ${agent} complete`;

  } catch (err) {
    _agentStates[agent] = 'failed';
    _pushStatus(agent, false);
    _resetStatusBar();
    vscode.window.showErrorMessage(`RunChecks: ${agent} failed — ${(err as Error).message}`);
  }
}

async function _runSkeptic(): Promise<void> {
  if (!currentSessionId) { return; }

  _agentStates['skeptic'] = 'running';
  _pushStatus('skeptic', false);
  statusBarItem.text = '$(sync~spin) RunChecks — Running Skeptic…';

  try {
    let nextResult!: client.NextAgentResponse;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'RunChecks: Running Skeptic…', cancellable: false },
      async () => { nextResult = await client.runNextAgent(currentSessionId!, 'skeptic'); }
    );

    const passed = nextResult.agentResult?.['status'] === 'pass';
    _agentStates['skeptic'] = passed ? 'passed' : 'failed';
    _pushStatus('skeptic', true);

    // Show skeptic results in the same FindingsPanel tab (no new tab)
    FindingsPanel.showSkeptic(_context.extensionUri, nextResult.agentResult);
    statusBarItem.text = '$(shield) RunChecks — Skeptic complete';

  } catch (err) {
    _agentStates['skeptic'] = 'failed';
    _pushStatus('skeptic', false);
    _resetStatusBar();
    vscode.window.showErrorMessage(`RunChecks: Skeptic failed — ${(err as Error).message}`);
  }
}

async function _finalizeReview(): Promise<void> {
  if (!currentSessionId) { return; }

  _agentStates['orchestrator'] = 'running';
  _pushStatus('orchestrator', false);

  try {
    let finalResult!: client.FinalizeResponse;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'RunChecks: Computing verdict…', cancellable: false },
      async () => { finalResult = await client.finalizeReview(currentSessionId!); }
    );

    currentSessionId = undefined;
    _agentStates['orchestrator'] = 'passed';
    _pushStatus('', false);

    // Show final verdict page in the same panel
    FindingsPanel.showVerdict(_context.extensionUri, finalResult);

    const { verdict, score } = finalResult;
    const icon = verdict === 'APPROVE' ? '✅' : verdict === 'BLOCK' ? '🚫' : '⚠️';
    statusBarItem.text = `${icon} RunChecks — ${verdict} (${score}/100)`;

  } catch (err) {
    _agentStates['orchestrator'] = 'failed';
    _pushStatus('', false);
    vscode.window.showErrorMessage(`RunChecks: Finalize failed — ${(err as Error).message}`);
    _resetStatusBar();
  }
}

// ─── Panel decision handler ────────────────────────────────────────────────────

async function _handleFindingsDecision(stage: string, decision: string): Promise<void> {
  if (decision === 'change') {
    vscode.window.showInformationMessage('RunChecks: Review stopped. Address the findings and run again.');
    _resetAllAgentStates();
    _resetStatusBar();
    return;
  }

  // decision === 'approve'
  if (stage === 'factchecker') {
    await _runAgent('attacker');

  } else if (stage === 'attacker') {
    const pick = await vscode.window.showInformationMessage(
      'Attacker stage complete. Optionally run Skeptic shadow analysis, or finalize now.',
      { modal: true },
      'Run Skeptic',
      'Finalize Now'
    );
    if (pick === 'Run Skeptic') {
      await _runSkeptic();
    } else if (pick === 'Finalize Now') {
      await _finalizeReview();
    }
    // pick === undefined means user pressed Escape/X — stay on current panel, do nothing

  } else if (stage === 'skeptic') {
    await _finalizeReview();

  } else {
    // pre-processing stage
    await _runAgent('factchecker');
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _resetStatusBar(): void {
  statusBarItem.text = '$(shield) RunChecks';
}

/** Maps raw backend agent output → the TypeScript AgentResult shape FindingsPanel expects. */
function _adaptAgentResult(raw: Record<string, unknown>, agent: string): AgentResult {
  const rawFindings = (raw['findings'] as Record<string, unknown>[] | undefined) ?? [];
  const findings: AgentFinding[] = rawFindings.map(f => ({
    type:        String(f['type']   ?? f['category']    ?? 'issue'),
    severity:    (['critical','high','medium','low'].includes(String(f['severity']))
                    ? f['severity'] : 'low') as AgentFinding['severity'],
    file:        String(f['filePath'] ?? f['file']      ?? currentFilePath ?? ''),
    line:        Number(f['line']     ?? 0),
    // For factchecker: prefer reality (mismatch description) over claim for the main text
    description: String(f['description'] ?? f['reality'] ?? f['claim'] ?? ''),
    suggestion:  String(f['suggestion']  ?? ''),
    // Factchecker-specific extras — passed through so FindingsPanel renders them richly
    codeSnippet: f['codeSnippet'] ? String(f['codeSnippet']) : undefined,
    claim:       f['claim']       ? String(f['claim'])       : undefined,
    reality:     f['reality']     ? String(f['reality'])     : undefined,
    docSource:   f['docSource']   ? String(f['docSource'])   : undefined,
    docSection:  f['docSection']  ? String(f['docSection'])  : undefined,
    docPage:     f['docPage'] != null ? Number(f['docPage']) : undefined,
  }));

  return {
    agentName: String(raw['agent'] ?? agent),
    stage:     agent as AgentResult['stage'],
    passed:    raw['status'] === 'pass',
    findings,
    summary:   raw['summary'] ? String(raw['summary']) : undefined,
  };
}
