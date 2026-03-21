import * as vscode from 'vscode';
import { MigrationPanel } from './migrationPanel';

export function activate(context: vscode.ExtensionContext): void {
  console.log('Code Migration Assistant activated');

  // Register main command
  context.subscriptions.push(
    vscode.commands.registerCommand('migrationAssistant.open', () => {
      MigrationPanel.createOrShow(context);
    })
  );

  // Register clear history command
  context.subscriptions.push(
    vscode.commands.registerCommand('migrationAssistant.clearHistory', () => {
      if (MigrationPanel.currentPanel) {
        MigrationPanel.currentPanel.dispose();
      }
      vscode.window.showInformationMessage('Migration Assistant: History cleared.');
    })
  );

  // Show status bar button
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99
  );
  statusBarItem.command = 'migrationAssistant.open';
  statusBarItem.text = '$(rocket) Migration';
  statusBarItem.tooltip = 'Open Code Migration Assistant';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Auto-open on first activation if no panel exists
  if (!MigrationPanel.currentPanel) {
    // Only auto-open when explicitly activated via command
    // (do not auto-open on workspace load)
  }
}

export function deactivate(): void {
  if (MigrationPanel.currentPanel) {
    MigrationPanel.currentPanel.dispose();
  }
}
