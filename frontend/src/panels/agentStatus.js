const vscode = require('vscode');

class AgentStatusProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData  = this._onDidChangeTreeData.event;
    this._result = null;
  }

  setResult(result) {
    this._result = result;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) { return element; }

  getChildren() {
    if (!this._result) return [new vscode.TreeItem('No review run yet.')];

    const icon = { pass: '✅', warn: '⚠️', fail: '❌' };
    return Object.entries(this._result.agentResults || {}).map(([name, data]) => {
      const item = new vscode.TreeItem(
        `${icon[data?.status] ?? '❓'} ${name}`,
        vscode.TreeItemCollapsibleState.None
      );
      item.description = data?.status ?? 'unknown';
      item.tooltip = data?.summary ?? '';
      return item;
    });
  }
}

/** @type {AgentStatusProvider|null} */
let provider = null;

const AgentStatusPanel = {
  register(context) {
    provider = new AgentStatusProvider();
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider('codeReview.agentStatus', provider)
    );
  },
  refresh(_context, result) { if (provider) provider.setResult(result); },
};

module.exports = { AgentStatusPanel };
