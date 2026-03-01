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
    const { verdict, score, summary } = this._result;
    const icon = { approve: '✅', 'request-changes': '⚠️', block: '🚫' }[verdict] ?? '❓';
    return [
      new vscode.TreeItem(`${icon} Verdict: ${verdict ?? 'unknown'}`),
      new vscode.TreeItem(`Score: ${score ?? '—'} / 100`),
      new vscode.TreeItem(`Summary: ${summary ?? ''}`),
    ];
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
