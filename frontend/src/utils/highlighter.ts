import * as vscode from 'vscode';

type Severity = 'critical' | 'high' | 'medium' | 'low';

const COLOURS: Record<Severity, string> = {
  critical: '#ef4444',
  high:     '#f97316',
  medium:   '#eab308',
  low:      '#3b82f6',
};

/** One decoration type per severity — created once, reused. */
const decorationTypes: Partial<Record<Severity, vscode.TextEditorDecorationType>> = {};

function getDecorationType(severity: Severity): vscode.TextEditorDecorationType {
  if (!decorationTypes[severity]) {
    const colour = COLOURS[severity];
    decorationTypes[severity] = vscode.window.createTextEditorDecorationType({
      borderWidth:   '0 0 0 3px',
      borderStyle:   'solid',
      borderColor:   colour,
      gutterIconPath: _makeGutterIcon(colour),
      gutterIconSize: '70%',
      overviewRulerColor:    colour,
      overviewRulerLane:     vscode.OverviewRulerLane.Left,
      isWholeLine: true,
    });
  }
  return decorationTypes[severity]!;
}

/**
 * Highlight specific line numbers in the given file.
 * Lines are 1-based.
 * Always opens/reveals the source file in its existing column (or Column.One),
 * never in the webview column, so the findings panel stays visible.
 */
export async function highlightLines(
  filePath:    string,
  lineNumbers: number[],
  severity:    Severity
): Promise<void> {
  if (!filePath) { return; }
  const uri = vscode.Uri.file(filePath);
  const doc = await vscode.workspace.openTextDocument(uri);

  // Find the file in an already-visible editor to reuse its column
  const existing = vscode.window.visibleTextEditors.find(
    e => e.document.uri.fsPath === uri.fsPath
  );

  const editor = await vscode.window.showTextDocument(doc, {
    viewColumn:    existing?.viewColumn ?? vscode.ViewColumn.One,
    preview:       false,
    preserveFocus: true,   // keep focus on the findings panel
  });

  const validLines = lineNumbers.filter(n => n >= 1 && n <= doc.lineCount);
  const ranges = validLines.map(
    n => new vscode.Range(n - 1, 0, n - 1, doc.lineAt(n - 1).text.length)
  );
  editor.setDecorations(getDecorationType(severity), ranges);
}

/** Remove all RunChecks decorations from all editors. */
export function clearHighlights(): void {
  const editors = vscode.window.visibleTextEditors;
  for (const severity of Object.keys(decorationTypes) as Severity[]) {
    const dt = decorationTypes[severity];
    if (dt) { editors.forEach(e => e.setDecorations(dt, [])); }
  }
}

/**
 * Open a file and scroll to the given line (1-based).
 * Reuses the file's existing editor column so the webview panel is not disturbed.
 * Focuses the editor so the user can see the navigated-to line.
 */
export async function jumpToLine(filePath: string, lineNumber: number): Promise<void> {
  if (!filePath || !lineNumber || lineNumber < 1) { return; }

  const uri  = vscode.Uri.file(filePath);
  const doc  = await vscode.workspace.openTextDocument(uri);

  // Clamp to valid line index (0-based)
  const lineIdx = Math.min(lineNumber - 1, doc.lineCount - 1);
  const pos     = new vscode.Position(lineIdx, 0);

  // Reuse the column the file is already in; fall back to Column.One
  const existing = vscode.window.visibleTextEditors.find(
    e => e.document.uri.fsPath === uri.fsPath
  );

  await vscode.window.showTextDocument(doc, {
    viewColumn:    existing?.viewColumn ?? vscode.ViewColumn.One,
    selection:     new vscode.Range(pos, pos),
    preview:       false,
    preserveFocus: false,  // focus the editor so the user sees the line
  });
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _makeGutterIcon(colour: string): vscode.Uri {
  // Inline SVG circle as a data URI for the gutter icon
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="${colour}"/></svg>`;
  return vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
}
