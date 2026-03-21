"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const migrationPanel_1 = require("./migrationPanel");
function activate(context) {
    console.log('Code Migration Assistant activated');
    // Register main command
    context.subscriptions.push(vscode.commands.registerCommand('migrationAssistant.open', () => {
        migrationPanel_1.MigrationPanel.createOrShow(context.extensionUri);
    }));
    // Register clear history command
    context.subscriptions.push(vscode.commands.registerCommand('migrationAssistant.clearHistory', () => {
        if (migrationPanel_1.MigrationPanel.currentPanel) {
            migrationPanel_1.MigrationPanel.currentPanel.dispose();
        }
        vscode.window.showInformationMessage('Migration Assistant: History cleared.');
    }));
    // Show status bar button
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    statusBarItem.command = 'migrationAssistant.open';
    statusBarItem.text = '$(rocket) Migration';
    statusBarItem.tooltip = 'Open Code Migration Assistant';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    // Auto-open on first activation if no panel exists
    if (!migrationPanel_1.MigrationPanel.currentPanel) {
        // Only auto-open when explicitly activated via command
        // (do not auto-open on workspace load)
    }
}
function deactivate() {
    if (migrationPanel_1.MigrationPanel.currentPanel) {
        migrationPanel_1.MigrationPanel.currentPanel.dispose();
    }
}
//# sourceMappingURL=extension.js.map