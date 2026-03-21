import * as vscode from 'vscode';
import { analyzeRepository } from './githubAnalyzer';
import { streamMigrationPlan } from './copilotService';
import {
  WebviewMessage,
  ExtensionMessage,
  RepoAnalysis,
  AnalysisOptions,
} from './types';

export class MigrationPanel {
  public static currentPanel: MigrationPanel | undefined;
  private static readonly viewType = 'migrationAssistant';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _cancellationSource?: vscode.CancellationTokenSource;
  private _lastAnalysis?: RepoAnalysis;

  // ─── Static Factory ──────────────────────────────────────────────────────────

  public static createOrShow(extensionUri: vscode.Uri): MigrationPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (MigrationPanel.currentPanel) {
      MigrationPanel.currentPanel._panel.reveal(column);
      return MigrationPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      MigrationPanel.viewType,
      'Migration Assistant',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    MigrationPanel.currentPanel = new MigrationPanel(panel, extensionUri);
    return MigrationPanel.currentPanel;
  }

  // ─── Constructor ──────────────────────────────────────────────────────────────

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;

    this._panel.webview.html = this._getWebviewContent();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this._handleMessage(msg),
      null,
      this._disposables
    );
  }

  // ─── Message Handler ──────────────────────────────────────────────────────────

  private async _handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this._sendSettings();
        break;

      case 'analyze':
        await this._runAnalysis(msg.repoUrl!, msg.githubToken);
        break;

      case 'generatePlan':
        if (!this._lastAnalysis) {
          this._post({ type: 'error', message: 'Please analyze a repository first.' });
          return;
        }
        await this._runMigrationPlan(
          this._lastAnalysis,
          msg.targetStack!,
          msg.options!
        );
        break;

      case 'stopGeneration':
        this._cancellationSource?.cancel();
        this._post({ type: 'stopped' });
        break;

      case 'openSettings':
        vscode.commands.executeCommand('workbench.action.openSettings', 'migrationAssistant');
        break;
    }
  }

  // ─── Send Saved Settings ──────────────────────────────────────────────────────

  private _sendSettings(): void {
    const config = vscode.workspace.getConfiguration('migrationAssistant');
    const githubToken = config.get<string>('githubToken', '');
    const copilotModel = config.get<string>('copilotModel', 'gpt-4o');
    this._post({ type: 'settingsLoaded', settings: { githubToken, copilotModel } });
  }

  // ─── Analysis ─────────────────────────────────────────────────────────────────

  private async _runAnalysis(repoUrl: string, githubToken?: string): Promise<void> {
    // Use token from settings if not provided in UI
    const config = vscode.workspace.getConfiguration('migrationAssistant');
    const token = githubToken || config.get<string>('githubToken') || undefined;

    try {
      const analysis = await analyzeRepository(
        repoUrl,
        token,
        (message, step, total) => {
          this._post({ type: 'progress', message, step, totalSteps: total });
        }
      );

      this._lastAnalysis = analysis;
      this._post({ type: 'analysisComplete', analysis });
    } catch (err: any) {
      this._post({ type: 'error', message: err.message || String(err) });
    }
  }

  // ─── Migration Plan ───────────────────────────────────────────────────────────

  private async _runMigrationPlan(
    analysis: RepoAnalysis,
    targetStack: string,
    options: AnalysisOptions
  ): Promise<void> {
    this._cancellationSource?.cancel();
    this._cancellationSource = new vscode.CancellationTokenSource();
    const token = this._cancellationSource.token;

    this._post({ type: 'planChunk', chunk: '' }); // clear signal

    try {
      await streamMigrationPlan(
        analysis,
        targetStack,
        options,
        (chunk) => this._post({ type: 'planChunk', chunk }),
        token
      );
      this._post({ type: 'planComplete' });
    } catch (err: any) {
      if (token.isCancellationRequested) {
        this._post({ type: 'stopped' });
      } else {
        this._post({ type: 'error', message: err.message || String(err) });
      }
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  private _post(msg: ExtensionMessage): void {
    this._panel.webview.postMessage(msg);
  }

  public dispose(): void {
    MigrationPanel.currentPanel = undefined;
    this._cancellationSource?.cancel();
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      d?.dispose();
    }
  }

  // ─── Webview HTML ─────────────────────────────────────────────────────────────

  private _getWebviewContent(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Migration Assistant</title>
<style>
  :root {
    --radius: 6px;
    --gap: 12px;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Header ── */
  .header {
    background: var(--vscode-titleBar-activeBackground);
    border-bottom: 1px solid var(--vscode-panel-border);
    padding: 10px 16px;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }
  .header-icon { font-size: 20px; }
  .header h1 {
    font-size: 14px;
    font-weight: 600;
    color: var(--vscode-titleBar-activeForeground);
    flex: 1;
  }
  .header-actions { display: flex; gap: 6px; }
  .icon-btn {
    background: none;
    border: none;
    color: var(--vscode-titleBar-activeForeground);
    cursor: pointer;
    padding: 4px 6px;
    border-radius: var(--radius);
    font-size: 13px;
    opacity: 0.7;
  }
  .icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }

  /* ── Layout ── */
  .main {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  /* ── Left Panel ── */
  .sidebar {
    width: 320px;
    min-width: 260px;
    border-right: 1px solid var(--vscode-panel-border);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    padding: 14px;
    gap: var(--gap);
    flex-shrink: 0;
  }

  .section-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 6px;
  }

  label {
    display: block;
    font-size: 12px;
    color: var(--vscode-foreground);
    margin-bottom: 4px;
  }

  input, select, textarea {
    width: 100%;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: var(--radius);
    padding: 6px 8px;
    font-family: inherit;
    font-size: 12px;
    outline: none;
  }
  input:focus, select:focus, textarea:focus {
    border-color: var(--vscode-focusBorder);
  }
  input::placeholder { color: var(--vscode-input-placeholderForeground); }

  textarea { resize: vertical; min-height: 60px; }

  .field { display: flex; flex-direction: column; gap: 4px; }

  /* ── Buttons ── */
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 7px 12px;
    border-radius: var(--radius);
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    border: none;
    transition: opacity 0.15s;
    width: 100%;
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .btn-primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .btn-secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .btn-secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  .btn-danger {
    background: var(--vscode-inputValidation-errorBackground);
    color: var(--vscode-errorForeground);
    border: 1px solid var(--vscode-inputValidation-errorBorder);
  }

  /* ── Options checkboxes ── */
  .options-grid {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .option-item {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    cursor: pointer;
  }
  .option-item input[type=checkbox] { width: auto; cursor: pointer; }

  /* ── Detected Stack ── */
  .stack-card {
    background: var(--vscode-editor-inactiveSelectionBackground);
    border: 1px solid var(--vscode-panel-border);
    border-radius: var(--radius);
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .stack-row {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    gap: 8px;
  }
  .stack-key { color: var(--vscode-descriptionForeground); flex-shrink: 0; }
  .stack-val {
    color: var(--vscode-foreground);
    font-weight: 500;
    text-align: right;
    word-break: break-word;
  }
  .badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 10px;
    font-size: 10px;
    font-weight: 600;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    margin-left: 4px;
  }

  /* ── Progress ── */
  .progress-bar-wrap {
    background: var(--vscode-progressBar-background, var(--vscode-panel-border));
    border-radius: 3px;
    height: 3px;
    overflow: hidden;
  }
  .progress-bar {
    height: 100%;
    background: var(--vscode-progressBar-background, var(--vscode-focusBorder));
    background: var(--vscode-focusBorder);
    border-radius: 3px;
    transition: width 0.3s ease;
  }
  .progress-text {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-top: 4px;
  }

  /* ── Right Panel ── */
  .content {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .content-tabs {
    display: flex;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }
  .tab {
    padding: 8px 16px;
    font-size: 12px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    color: var(--vscode-descriptionForeground);
    background: none;
    border-top: none;
    border-left: none;
    border-right: none;
    font-family: inherit;
    transition: color 0.15s;
  }
  .tab.active {
    color: var(--vscode-foreground);
    border-bottom-color: var(--vscode-focusBorder);
  }
  .tab:hover { color: var(--vscode-foreground); }

  .tab-content { display: none; flex: 1; overflow: auto; padding: 16px; }
  .tab-content.active { display: block; }

  /* ── Empty state ── */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 10px;
    color: var(--vscode-descriptionForeground);
    text-align: center;
    padding: 40px;
  }
  .empty-icon { font-size: 48px; opacity: 0.4; }
  .empty-title { font-size: 16px; font-weight: 600; }
  .empty-sub { font-size: 12px; max-width: 300px; line-height: 1.6; }

  /* ── Markdown output ── */
  #plan-output {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 13px;
    line-height: 1.7;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--vscode-editor-foreground);
  }

  /* Basic markdown rendering */
  #plan-rendered h1, #plan-rendered h2, #plan-rendered h3 {
    margin: 16px 0 8px;
    font-weight: 600;
  }
  #plan-rendered h1 { font-size: 18px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 6px; }
  #plan-rendered h2 { font-size: 15px; }
  #plan-rendered h3 { font-size: 13px; }
  #plan-rendered p { margin: 6px 0; line-height: 1.6; }
  #plan-rendered ul, #plan-rendered ol { padding-left: 20px; margin: 6px 0; }
  #plan-rendered li { margin: 3px 0; }
  #plan-rendered code {
    background: var(--vscode-textCodeBlock-background);
    padding: 1px 4px;
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
  }
  #plan-rendered pre {
    background: var(--vscode-textCodeBlock-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: var(--radius);
    padding: 10px;
    overflow-x: auto;
    margin: 8px 0;
  }
  #plan-rendered pre code { background: none; padding: 0; }
  #plan-rendered table {
    width: 100%;
    border-collapse: collapse;
    margin: 10px 0;
    font-size: 12px;
  }
  #plan-rendered th, #plan-rendered td {
    border: 1px solid var(--vscode-panel-border);
    padding: 6px 10px;
    text-align: left;
  }
  #plan-rendered th { background: var(--vscode-editor-inactiveSelectionBackground); font-weight: 600; }
  #plan-rendered blockquote {
    border-left: 3px solid var(--vscode-focusBorder);
    margin: 8px 0;
    padding: 4px 12px;
    color: var(--vscode-descriptionForeground);
  }
  #plan-rendered strong { font-weight: 600; }
  #plan-rendered em { font-style: italic; }
  #plan-rendered hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 16px 0; }

  /* ── Cursor blink ── */
  .cursor {
    display: inline-block;
    width: 2px;
    height: 14px;
    background: var(--vscode-foreground);
    animation: blink 1s infinite;
    vertical-align: middle;
    margin-left: 2px;
  }
  @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }

  /* ── Error / info messages ── */
  .msg-error {
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder);
    color: var(--vscode-errorForeground);
    border-radius: var(--radius);
    padding: 8px 12px;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
  }

  /* ── File tree ── */
  .file-tree {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    color: var(--vscode-foreground);
    line-height: 1.6;
    column-count: 2;
    column-gap: 20px;
  }
  .file-tree div { word-break: break-all; }

  /* ── Copy button ── */
  .copy-btn {
    font-size: 11px;
    padding: 4px 10px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    border-radius: var(--radius);
    cursor: pointer;
    width: auto;
  }
  .copy-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }

  .plan-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
    flex-shrink: 0;
  }

  .generating-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }
  .dot-pulse {
    display: flex;
    gap: 3px;
    align-items: center;
  }
  .dot-pulse span {
    width: 4px; height: 4px;
    border-radius: 50%;
    background: var(--vscode-focusBorder);
    animation: dot-pulse 1.4s infinite ease-in-out both;
  }
  .dot-pulse span:nth-child(2) { animation-delay: 0.2s; }
  .dot-pulse span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes dot-pulse {
    0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
    40% { transform: scale(1); opacity: 1; }
  }
</style>
</head>
<body>

<!-- Header -->
<div class="header">
  <span class="header-icon">🚀</span>
  <h1>Code Migration Assistant</h1>
  <div class="header-actions">
    <button class="icon-btn" id="btn-settings" title="Open Settings">⚙</button>
  </div>
</div>

<div class="main">

  <!-- Sidebar -->
  <div class="sidebar">

    <!-- Step 1: Repository -->
    <div>
      <div class="section-title">Step 1 — Repository</div>
      <div class="field">
        <label for="input-repo">GitHub Repository URL</label>
        <input id="input-repo" type="text"
          placeholder="https://github.com/owner/repo" />
      </div>
      <div class="field" style="margin-top:8px">
        <label for="input-token">GitHub Token <span style="opacity:0.6">(optional, for private repos)</span></label>
        <input id="input-token" type="password" placeholder="ghp_…" />
      </div>
      <button class="btn btn-primary" id="btn-analyze" style="margin-top:10px">
        🔍 Analyze Repository
      </button>
      <div id="progress-section" style="margin-top:10px; display:none">
        <div class="progress-bar-wrap">
          <div class="progress-bar" id="progress-bar" style="width:0%"></div>
        </div>
        <div class="progress-text" id="progress-text">Starting…</div>
      </div>
      <div id="error-box" style="margin-top:10px; display:none"></div>
    </div>

    <!-- Divider -->
    <hr style="border:none;border-top:1px solid var(--vscode-panel-border)">

    <!-- Step 2: Target Stack -->
    <div>
      <div class="section-title">Step 2 — Target Stack</div>
      <div class="field">
        <label for="input-target">Target Technology / Version</label>
        <textarea id="input-target" rows="3"
          placeholder="e.g. React 18 + TypeScript 5 + Vite&#10;or: Spring Boot 3 + Java 21&#10;or: Next.js 14 App Router + Tailwind CSS"></textarea>
      </div>

      <div class="field" style="margin-top:8px">
        <label>Quick Presets</label>
        <select id="preset-select">
          <option value="">— choose a preset —</option>
          <optgroup label="JavaScript / TypeScript">
            <option value="Node.js 20 LTS + Express 5 + TypeScript 5">Node.js 20 + Express 5 + TypeScript</option>
            <option value="Next.js 14 with App Router + TypeScript 5 + Tailwind CSS">Next.js 14 App Router + TypeScript + Tailwind</option>
            <option value="React 18 + Vite + TypeScript 5 + Vitest">React 18 + Vite + TypeScript + Vitest</option>
            <option value="NestJS 10 + TypeScript 5 + Prisma ORM + PostgreSQL">NestJS 10 + Prisma + PostgreSQL</option>
            <option value="Vue 3 Composition API + Vite + TypeScript 5 + Pinia">Vue 3 + Vite + TypeScript + Pinia</option>
          </optgroup>
          <optgroup label="Python">
            <option value="FastAPI + Python 3.12 + Pydantic v2 + SQLAlchemy 2">FastAPI + Python 3.12 + SQLAlchemy 2</option>
            <option value="Django 5 + Python 3.12 + Django REST Framework 3">Django 5 + Python 3.12 + DRF</option>
          </optgroup>
          <optgroup label="Java">
            <option value="Spring Boot 3.2 + Java 21 + Spring Security 6 + JPA">Spring Boot 3.2 + Java 21</option>
            <option value="Quarkus 3 + Java 21 + GraalVM native image">Quarkus 3 + Java 21 + GraalVM</option>
          </optgroup>
          <optgroup label="Go">
            <option value="Go 1.22 + Gin 1.9 + GORM v2 + PostgreSQL">Go 1.22 + Gin + GORM</option>
            <option value="Go 1.22 + Chi router + sqlc + PostgreSQL">Go 1.22 + Chi + sqlc</option>
          </optgroup>
          <optgroup label="Other">
            <option value="Rust + Axum + SQLx + PostgreSQL">Rust + Axum + SQLx</option>
            <option value="Bun + Elysia + Drizzle ORM + PostgreSQL">Bun + Elysia + Drizzle</option>
          </optgroup>
        </select>
      </div>

      <div style="margin-top:8px">
        <div class="section-title" style="margin-bottom:6px">Include in plan</div>
        <div class="options-grid">
          <label class="option-item">
            <input type="checkbox" id="opt-tests" checked> Test migration
          </label>
          <label class="option-item">
            <input type="checkbox" id="opt-ci" checked> CI/CD pipeline updates
          </label>
          <label class="option-item">
            <input type="checkbox" id="opt-docker" checked> Docker/container updates
          </label>
        </div>
      </div>

      <div class="field" style="margin-top:8px">
        <label for="detail-level">Detail level</label>
        <select id="detail-level">
          <option value="summary">Summary</option>
          <option value="detailed" selected>Detailed</option>
          <option value="file-by-file">File-by-file</option>
        </select>
      </div>

      <button class="btn btn-primary" id="btn-generate" style="margin-top:10px" disabled>
        ✨ Generate Migration Plan
      </button>
      <button class="btn btn-danger" id="btn-stop" style="margin-top:6px; display:none">
        ⏹ Stop Generation
      </button>
    </div>

    <!-- Detected Stack (shown after analysis) -->
    <div id="stack-section" style="display:none">
      <hr style="border:none;border-top:1px solid var(--vscode-panel-border); margin-bottom:10px">
      <div class="section-title">Detected Stack</div>
      <div class="stack-card" id="stack-card"></div>
    </div>

  </div>

  <!-- Content Area -->
  <div class="content">
    <div class="content-tabs">
      <button class="tab active" data-tab="plan">Migration Plan</button>
      <button class="tab" data-tab="files">File Tree</button>
      <button class="tab" data-tab="raw">Raw Text</button>
    </div>

    <!-- Plan Tab -->
    <div class="tab-content active" id="tab-plan">
      <div id="plan-empty" class="empty-state">
        <div class="empty-icon">🗺️</div>
        <div class="empty-title">No plan yet</div>
        <div class="empty-sub">
          Enter a GitHub repository URL and target stack, then click
          <strong>Generate Migration Plan</strong> to get AI-powered modernization suggestions.
        </div>
      </div>
      <div id="plan-container" style="display:none; height:100%; display:none; flex-direction:column">
        <div class="plan-header">
          <div id="generating-indicator" class="generating-indicator" style="display:none">
            <div class="dot-pulse"><span></span><span></span><span></span></div>
            Generating plan…
          </div>
          <div style="flex:1"></div>
          <button class="copy-btn" id="btn-copy">Copy</button>
        </div>
        <div id="plan-rendered" style="flex:1; overflow:auto"></div>
      </div>
    </div>

    <!-- Files Tab -->
    <div class="tab-content" id="tab-files">
      <div class="empty-state" id="files-empty">
        <div class="empty-icon">📁</div>
        <div class="empty-title">No repository analyzed</div>
        <div class="empty-sub">Analyze a repository to see its file structure.</div>
      </div>
      <div id="files-container" style="display:none">
        <div id="files-header" style="margin-bottom:12px; font-size:12px; color:var(--vscode-descriptionForeground)"></div>
        <div class="file-tree" id="file-tree-content"></div>
      </div>
    </div>

    <!-- Raw Tab -->
    <div class="tab-content" id="tab-raw">
      <div class="empty-state" id="raw-empty">
        <div class="empty-icon">📄</div>
        <div class="empty-title">No plan generated</div>
        <div class="empty-sub">Generate a plan to see raw markdown output.</div>
      </div>
      <pre id="plan-output" style="display:none"></pre>
    </div>

  </div>
</div>

<script>
const vscode = acquireVsCodeApi();

// ─── State ────────────────────────────────────────────────────────────────────
let planMarkdown = '';
let analysisData = null;
let isGenerating = false;

// ─── Element Refs ──────────────────────────────────────────────────────────────
const btnAnalyze    = document.getElementById('btn-analyze');
const btnGenerate   = document.getElementById('btn-generate');
const btnStop       = document.getElementById('btn-stop');
const btnSettings   = document.getElementById('btn-settings');
const btnCopy       = document.getElementById('btn-copy');
const inputRepo     = document.getElementById('input-repo');
const inputToken    = document.getElementById('input-token');
const inputTarget   = document.getElementById('input-target');
const presetSelect  = document.getElementById('preset-select');
const detailLevel   = document.getElementById('detail-level');
const optTests      = document.getElementById('opt-tests');
const optCi         = document.getElementById('opt-ci');
const optDocker     = document.getElementById('opt-docker');
const progressSect  = document.getElementById('progress-section');
const progressBar   = document.getElementById('progress-bar');
const progressText  = document.getElementById('progress-text');
const errorBox      = document.getElementById('error-box');
const stackSection  = document.getElementById('stack-section');
const stackCard     = document.getElementById('stack-card');
const planEmpty     = document.getElementById('plan-empty');
const planContainer = document.getElementById('plan-container');
const planRendered  = document.getElementById('plan-rendered');
const planOutput    = document.getElementById('plan-output');
const filesEmpty    = document.getElementById('files-empty');
const filesContainer= document.getElementById('files-container');
const filesHeader   = document.getElementById('files-header');
const fileTreeCont  = document.getElementById('file-tree-content');
const rawEmpty      = document.getElementById('raw-empty');
const genIndicator  = document.getElementById('generating-indicator');

// ─── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
});

// ─── Preset select ─────────────────────────────────────────────────────────────
presetSelect.addEventListener('change', () => {
  if (presetSelect.value) {
    inputTarget.value = presetSelect.value;
    presetSelect.value = '';
  }
});

// ─── Settings ─────────────────────────────────────────────────────────────────
btnSettings.addEventListener('click', () => {
  vscode.postMessage({ type: 'openSettings' });
});

// ─── Analyze ──────────────────────────────────────────────────────────────────
btnAnalyze.addEventListener('click', () => {
  const repoUrl = inputRepo.value.trim();
  if (!repoUrl) { showError('Please enter a GitHub repository URL.'); return; }
  hideError();
  progressSect.style.display = 'block';
  btnAnalyze.disabled = true;
  stackSection.style.display = 'none';
  btnGenerate.disabled = true;
  vscode.postMessage({
    type: 'analyze',
    repoUrl,
    githubToken: inputToken.value.trim() || undefined,
  });
});

// ─── Generate ─────────────────────────────────────────────────────────────────
btnGenerate.addEventListener('click', () => {
  const target = inputTarget.value.trim();
  if (!target) { showError('Please enter a target stack or pick a preset.'); return; }
  hideError();
  startGeneration();
  vscode.postMessage({
    type: 'generatePlan',
    targetStack: target,
    options: {
      includeTestMigration: optTests.checked,
      includeCiMigration: optCi.checked,
      includeDockerMigration: optDocker.checked,
      detailLevel: detailLevel.value,
    },
  });
});

btnStop.addEventListener('click', () => {
  vscode.postMessage({ type: 'stopGeneration' });
});

btnCopy.addEventListener('click', () => {
  navigator.clipboard.writeText(planMarkdown).then(() => {
    btnCopy.textContent = 'Copied!';
    setTimeout(() => { btnCopy.textContent = 'Copy'; }, 2000);
  });
});

// ─── Message from extension ───────────────────────────────────────────────────
window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'settingsLoaded':
      if (msg.settings.githubToken) { inputToken.value = msg.settings.githubToken; }
      break;

    case 'progress':
      progressBar.style.width = ((msg.step / msg.totalSteps) * 100) + '%';
      progressText.textContent = msg.message;
      break;

    case 'analysisComplete':
      progressSect.style.display = 'none';
      btnAnalyze.disabled = false;
      analysisData = msg.analysis;
      renderStack(msg.analysis);
      renderFileTree(msg.analysis);
      btnGenerate.disabled = false;
      break;

    case 'planChunk':
      if (msg.chunk === '') {
        // Clear signal
        planMarkdown = '';
        planRendered.innerHTML = '';
        planOutput.textContent = '';
        showPlanContainer();
      } else {
        planMarkdown += msg.chunk;
        planRendered.innerHTML = parseMarkdown(planMarkdown);
        planOutput.textContent = planMarkdown;
        rawEmpty.style.display = 'none';
        planOutput.style.display = 'block';
        // Auto-scroll
        planRendered.scrollTop = planRendered.scrollHeight;
      }
      break;

    case 'planComplete':
      stopGeneration(false);
      break;

    case 'stopped':
      stopGeneration(true);
      break;

    case 'error':
      progressSect.style.display = 'none';
      btnAnalyze.disabled = false;
      stopGeneration(true);
      showError(msg.message);
      break;
  }
});

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function showError(msg) {
  errorBox.className = 'msg-error';
  errorBox.textContent = msg;
  errorBox.style.display = 'block';
}
function hideError() {
  errorBox.style.display = 'none';
}

function startGeneration() {
  isGenerating = true;
  btnGenerate.disabled = true;
  btnStop.style.display = 'flex';
  genIndicator.style.display = 'flex';
  planMarkdown = '';
  showPlanContainer();
}

function stopGeneration(cancelled) {
  isGenerating = false;
  btnGenerate.disabled = false;
  btnStop.style.display = 'none';
  genIndicator.style.display = 'none';
  if (cancelled && planMarkdown) {
    planMarkdown += '\\n\\n---\\n*Generation stopped.*';
    planRendered.innerHTML = parseMarkdown(planMarkdown);
  }
}

function showPlanContainer() {
  planEmpty.style.display = 'none';
  planContainer.style.display = 'flex';
}

function renderStack(analysis) {
  const s = analysis.detectedStack;
  const info = analysis.repoInfo;
  stackCard.innerHTML = [
    row('Repo', \`\${info.owner}/\${info.repo}\`),
    row('Language', s.primaryLanguage),
    row('Runtime', s.currentVersion || s.runtime),
    row('Framework', s.framework),
    row('Build Tool', s.buildTool),
    row('Pkg Manager', s.packageManager),
    row('CI/CD', s.ciSystem),
    row('Docker', s.containerized ? '✅ Yes' : '❌ No'),
    s.databases.length ? row('Databases', s.databases.join(', ')) : '',
    s.testingFrameworks.length ? row('Tests', s.testingFrameworks.join(', ')) : '',
    row('Files', analysis.totalFiles.toLocaleString()),
    row('Stars', '⭐ ' + info.stars.toLocaleString()),
  ].filter(Boolean).join('');
  stackSection.style.display = 'block';
}

function row(key, val) {
  return \`<div class="stack-row"><span class="stack-key">\${key}</span><span class="stack-val">\${escapeHtml(String(val))}</span></div>\`;
}

function renderFileTree(analysis) {
  filesHeader.textContent = \`\${analysis.totalFiles} files in \${analysis.repoInfo.owner}/\${analysis.repoInfo.repo} (\${analysis.repoInfo.defaultBranch})\`;
  fileTreeCont.innerHTML = analysis.fileTree
    .slice(0, 200)
    .map(f => \`<div>\${escapeHtml(f)}</div>\`)
    .join('');
  if (analysis.totalFiles > 200) {
    fileTreeCont.innerHTML += \`<div style="opacity:0.5;margin-top:8px">… and \${analysis.totalFiles - 200} more files</div>\`;
  }
  filesEmpty.style.display = 'none';
  filesContainer.style.display = 'block';
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Basic Markdown Parser ────────────────────────────────────────────────────
function parseMarkdown(md) {
  let html = escapeHtml(md);

  // Code blocks (must come before inline code)
  html = html.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, (_, lang, code) =>
    \`<pre><code class="language-\${lang}">\${code}</code></pre>\`
  );

  // Inline code
  html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold / Italic
  html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  html = html.replace(/\\*(.+?)\\*/g, '<em>$1</em>');

  // HR
  html = html.replace(/^---$/gm, '<hr>');

  // Tables
  html = html.replace(/((?:^\\|.+\\|\\n?)+)/gm, (tableBlock) => {
    const lines = tableBlock.trim().split('\\n').filter(l => l.trim());
    if (lines.length < 2) { return tableBlock; }
    const headerCells = lines[0].split('|').filter((_, i, a) => i > 0 && i < a.length - 1);
    const bodyLines = lines.slice(2);
    const header = '<tr>' + headerCells.map(c => \`<th>\${c.trim()}</th>\`).join('') + '</tr>';
    const body = bodyLines.map(line => {
      const cells = line.split('|').filter((_, i, a) => i > 0 && i < a.length - 1);
      return '<tr>' + cells.map(c => \`<td>\${c.trim()}</td>\`).join('') + '</tr>';
    }).join('');
    return \`<table><thead>\${header}</thead><tbody>\${body}</tbody></table>\`;
  });

  // Unordered lists
  html = html.replace(/^([ ]*)[*\\-] (.+)$/gm, (_, indent, item) => {
    const level = Math.floor(indent.length / 2);
    return \`<li style="margin-left:\${level*16}px">\${item}</li>\`;
  });
  html = html.replace(/(<li[^>]*>.*<\\/li>\\n?)+/g, match => \`<ul>\${match}</ul>\`);

  // Ordered lists
  html = html.replace(/^\\d+\\. (.+)$/gm, '<li>$1</li>');

  // Blockquote
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Paragraphs (double newlines)
  html = html.replace(/\\n\\n+/g, '</p><p>');
  html = '<p>' + html + '</p>';

  // Single newlines to <br> inside paragraphs (not inside pre/table/ul/li)
  html = html.replace(/(?<!>)\\n(?!<)/g, '<br>');

  // Clean up empty paragraphs
  html = html.replace(/<p>\\s*<\\/p>/g, '');
  html = html.replace(/<p>(<(?:h[1-6]|ul|ol|li|pre|table|hr|blockquote)[^>]*>)/g, '$1');
  html = html.replace(/(<\\/(?:h[1-6]|ul|ol|pre|table|blockquote)>)<\\/p>/g, '$1');

  return html;
}

// ─── Init ─────────────────────────────────────────────────────────────────────
vscode.postMessage({ type: 'ready' });

// Enter key on repo URL
inputRepo.addEventListener('keydown', e => {
  if (e.key === 'Enter') { btnAnalyze.click(); }
});
</script>
</body>
</html>`;
  }
}
