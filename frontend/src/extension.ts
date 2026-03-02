import * as vscode from 'vscode';
import { AgentStatusPanel } from './panels/AgentStatusPanel';
import { SetupPanel }       from './panels/SetupPanel';
import { FindingsPanel }    from './panels/FindingsPanel';
import { SkepticPanel }     from './panels/SkepticPanel';
import * as client          from './utils/backendClient';
import { clearHighlights }  from './utils/highlighter';
import type { AgentResult, AgentFinding, SkepticData } from './types/agents';

// ─── Module state ─────────────────────────────────────────────────────────────

let statusBarItem:    vscode.StatusBarItem;
let currentSessionId: string | undefined;
let currentFilePath:  string | undefined;
let _context:         vscode.ExtensionContext;

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
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AgentStatusPanel.viewType, agentStatusProvider)
  );

  // ── Wire panel decision callbacks ────────────────────────────────────────────
  FindingsPanel.onDecision = _handleFindingsDecision;
  SkepticPanel.onDecision  = _handleSkepticDecision;

  // ── Commands ────────────────────────────────────────────────────────────────
  context.subscriptions.push(

    vscode.commands.registerCommand('runchecks.startReview', () =>
      _startReview()
    ),

    vscode.commands.registerCommand('runchecks.openSetup', () =>
      SetupPanel.show(context.extensionUri)
    ),

    vscode.commands.registerCommand('runchecks.showStatus', () => {
      agentStatusProvider.focus();
      vscode.commands.executeCommand('runchecks.agentStatus.focus');
    }),
  );

  vscode.window.showInformationMessage(
    'RunChecks is active. Highlight code and right-click → "🔍 Run RunChecks Review".'
  );
}

// ─── Deactivate ───────────────────────────────────────────────────────────────

export function deactivate(): void {
  clearHighlights();
}

// ─── Review flow ──────────────────────────────────────────────────────────────

async function _startReview(): Promise<void> {
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

  vscode.commands.executeCommand('runchecks.showStatus');
  statusBarItem.text = '$(sync~spin) RunChecks — Pre-processing…';
  statusBarItem.show();

  try {
    let startResult!: client.StartReviewResponse;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'RunChecks: Parsing & reasoning…', cancellable: false },
      async () => { startResult = await client.startReview(code, filePath, lineStart, lineEnd); }
    );

    currentSessionId = startResult.sessionId;
    statusBarItem.text = '$(shield) RunChecks — Pre-processing complete';

    const pick = await vscode.window.showInformationMessage(
      '✅ RunChecks: Pre-processing complete. Ready to run Fact Checker.',
      'Run Fact Checker',
      'Stop'
    );

    if (pick !== 'Run Fact Checker') {
      _resetStatusBar();
      return;
    }

    await _runAgent('factchecker');

  } catch (err) {
    _resetStatusBar();
    vscode.window.showErrorMessage(`RunChecks: Failed to start — ${(err as Error).message}`);
  }
}

async function _runAgent(agent: string): Promise<void> {
  if (!currentSessionId) { return; }

  statusBarItem.text = `$(sync~spin) RunChecks — Running ${agent}…`;

  try {
    let nextResult!: client.NextAgentResponse;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `RunChecks: Running ${agent}…`, cancellable: false },
      async () => { nextResult = await client.runNextAgent(currentSessionId!, agent); }
    );

    const adapted = _adaptAgentResult(nextResult.agentResult, agent);
    FindingsPanel.show(_context.extensionUri, adapted);
    statusBarItem.text = `$(shield) RunChecks — ${agent} complete`;

  } catch (err) {
    _resetStatusBar();
    vscode.window.showErrorMessage(`RunChecks: ${agent} failed — ${(err as Error).message}`);
  }
}

async function _runSkeptic(): Promise<void> {
  if (!currentSessionId) { return; }

  statusBarItem.text = '$(sync~spin) RunChecks — Running Skeptic…';

  try {
    let nextResult!: client.NextAgentResponse;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'RunChecks: Running Skeptic…', cancellable: false },
      async () => { nextResult = await client.runNextAgent(currentSessionId!, 'skeptic'); }
    );

    const skepticData = nextResult.agentResult as unknown as SkepticData;
    SkepticPanel.show(_context.extensionUri, skepticData);
    statusBarItem.text = '$(shield) RunChecks — Skeptic complete';

  } catch (err) {
    _resetStatusBar();
    vscode.window.showErrorMessage(`RunChecks: Skeptic failed — ${(err as Error).message}`);
  }
}

async function _finalizeReview(): Promise<void> {
  if (!currentSessionId) { return; }

  try {
    let finalResult!: client.FinalizeResponse;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'RunChecks: Computing verdict…', cancellable: false },
      async () => { finalResult = await client.finalizeReview(currentSessionId!); }
    );

    currentSessionId = undefined;
    const { verdict, score } = finalResult;
    const icon = verdict === 'APPROVE' ? '✅' : verdict === 'BLOCK' ? '🚫' : '⚠️';
    vscode.window.showInformationMessage(`${icon} RunChecks: ${verdict} — Score: ${score}/100`);

  } catch (err) {
    vscode.window.showErrorMessage(`RunChecks: Finalize failed — ${(err as Error).message}`);
  } finally {
    _resetStatusBar();
  }
}

// ─── Panel decision handlers ───────────────────────────────────────────────────

async function _handleFindingsDecision(stage: string, decision: string): Promise<void> {
  if (decision === 'change') {
    vscode.window.showInformationMessage('RunChecks: Review stopped. Address the findings and run again.');
    _resetStatusBar();
    return;
  }

  if (decision === 'runSkeptic') {
    await _runSkeptic();
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
    } else {
      await _finalizeReview();
    }
  } else {
    // pre-processing or unknown
    await _runAgent('factchecker');
  }
}

async function _handleSkepticDecision(decision: string): Promise<void> {
  if (decision === 'approve') {
    await _finalizeReview();
  } else {
    vscode.window.showInformationMessage('RunChecks: Review stopped. Address the findings and run again.');
    _resetStatusBar();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _resetStatusBar(): void {
  statusBarItem.text = '$(shield) RunChecks';
}

/** Maps raw backend agent output → the TypeScript AgentResult shape FindingsPanel expects. */
function _adaptAgentResult(raw: Record<string, unknown>, agent: string): AgentResult {
  const rawFindings = (raw.findings as Record<string, unknown>[] | undefined) ?? [];
  const findings: AgentFinding[] = rawFindings.map(f => ({
    type:        String(f.type   ?? f.category    ?? 'issue'),
    severity:    (['critical','high','medium','low'].includes(String(f.severity))
                    ? f.severity : 'low') as AgentFinding['severity'],
    file:        String(f.filePath ?? f.file      ?? currentFilePath ?? ''),
    line:        Number(f.line     ?? 0),
    description: String(f.description ?? f.claim ?? ''),
    suggestion:  String(f.suggestion  ?? ''),
  }));

  return {
    agentName: String(raw.agent ?? agent),
    stage:     agent as AgentResult['stage'],
    passed:    raw.status === 'pass',
    findings,
    summary:   raw.summary ? String(raw.summary) : undefined,
  };
}
