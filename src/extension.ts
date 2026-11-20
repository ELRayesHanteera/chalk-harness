import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand('chalk.mcpStatus', () => {
    vscode.window.showInformationMessage('Chalk Whiteboard Harness initialized.');
  });
  context.subscriptions.push(disposable);
}

export function deactivate(): void {
  // Cleanup hook
}
