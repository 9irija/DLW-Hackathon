const vscode = require('vscode');

class VerdictProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData  = this._onDidChangeTreeData.event;
    this._result = null;
  }

  setResult(result) { this._result = result; this._onDidChangeTreeData.fire(); }
  getTreeItem(element) { return element; }

  getChildren() {
    if (!this._result) return [new vscode.TreeItem('No verdict yet.')];
    const { verdict, score, summary, prioritizedFindings = [], challengeResponses = [] } = this._result;
    const icon = { approve: '✅', 'request-changes': '⚠️', block: '🚫' }[verdict] ?? '❓';

    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    prioritizedFindings.forEach(f => { if (counts[f.severity] !== undefined) counts[f.severity]++; });
    const countStr = Object.entries(counts)
      .filter(([, n]) => n > 0).map(([s, n]) => `${n} ${s}`).join(', ') || 'none';

    const items = [
      new vscode.TreeItem(`${icon} ${(verdict ?? 'unknown').toUpperCase()}`),
      new vscode.TreeItem(`Score: ${score ?? '—'} / 100`),
      new vscode.TreeItem(`Findings: ${countStr}`),
    ];

    if (challengeResponses.length) {
      const ack = challengeResponses.filter(c => c.response?.challengeResponse?.assessment !== 'disputed').length;
      items.push(new vscode.TreeItem(`Builder: ${ack}/${challengeResponses.length} critical acknowledged`));
    }

    if (summary) {
      const s = new vscode.TreeItem(summary.slice(0, 80) + (summary.length > 80 ? '…' : ''));
      s.tooltip = summary;
      items.push(s);
    }

    return items;
  }
}

/** @type {VerdictProvider|null} */
let provider = null;

const VerdictPanel = {
  register(context) {
    provider = new VerdictProvider();
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider('codeReview.verdict', provider)
    );
  },
  refresh(_context, result) { if (provider) provider.setResult(result); },
};

module.exports = { VerdictPanel };
