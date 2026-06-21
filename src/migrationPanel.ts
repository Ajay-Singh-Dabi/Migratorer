import * as vscode from 'vscode';
import * as path from 'path';
import { analyzeRepository, analyzeOrg, fetchBranchDiff, scanLocalFolder, analyzeLocalRepository, analyzeLocalRepositories, focusAnalysisOnSubRepo, backupRepoFolder, readRepoFileFull, writeRepoFile } from './githubAnalyzer';
import {
  streamMigrationPlan,
  streamMigrationPlanTeam,
  streamMigrationPlanTeamDelta,
  streamArchitectureDoc,
  streamSecurityAudit,
  streamCorrectionPlan,
  rewriteFilePreservingBehavior,
  TeamCallbacks,
  TeamDiscussion,
  streamSingleSection,
  streamCoherenceCheck,
  streamDebugHelp,
  streamExecSummary,
  streamFilePreviews,
  streamProgressCheck,
  streamExportFormat,
  streamDetailedReport,
  streamStackRecommendations,
  streamStackHealthAnalysis,
  detectStackWithAI,
  streamChatReply,
  detectStackChangeIntent,
  streamPlanPatch,
  generatePresets,
  getAvailableModels,
  streamJiraStories,
  analyzeFilesInChunks,
} from './copilotService';
import { generateWordReport, generateHtmlReport } from './reportGenerator';
import {
  WebviewMessage,
  ExtensionMessage,
  RepoAnalysis,
  AnalysisOptions,
  CachedAnalysis,
  HistoryEntry,
  ChatMessage,
  StackChangeIntent,
  JiraStoriesConfig,
} from './types';

const CACHE_KEY    = 'migrationAssistant.analysisCache.v4';
const HISTORY_KEY  = 'migrationAssistant.history';
const MAX_HISTORY  = 8;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const TOKEN_SECRET_KEY = 'migrationAssistant.githubToken';

export class MigrationPanel {
  public static currentPanel: MigrationPanel | undefined;
  private static readonly viewType = 'migrationAssistant';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _secrets: vscode.SecretStorage;
  private readonly _globalState: vscode.Memento;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _cancellationSource?: vscode.CancellationTokenSource;
  private _lastAnalysis?: RepoAnalysis;
  private _lastPlan = '';
  private _coherenceReview = ''; // isolated — excluded from exports, chat, Jira, history
  private _lastTargetStack = '';
  private _lastOptions?: AnalysisOptions;
  private _chatHistory: ChatMessage[] = [];
  private _pendingStackChange?: StackChangeIntent;
  private _lastTeamDiscussion?: TeamDiscussion; // cached so a re-target can reuse it
  private _lastArchitecture = '';               // last generated LLD document
  private _lastSecurity = '';                    // last generated vulnerability report
  private _lastCorrection = '';                  // last generated correction plan
  private _applyRoots: Array<{ name: string; path: string }> = []; // local roots writable for apply

  // ─── Static Factory ──────────────────────────────────────────────────────────

  public static createOrShow(context: vscode.ExtensionContext): MigrationPanel {
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
        localResourceRoots: [context.extensionUri],
      }
    );

    MigrationPanel.currentPanel = new MigrationPanel(panel, context.secrets, context.globalState, context.extensionUri);
    return MigrationPanel.currentPanel;
  }

  // ─── Constructor ──────────────────────────────────────────────────────────────

  private constructor(panel: vscode.WebviewPanel, secrets: vscode.SecretStorage, globalState: vscode.Memento, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._secrets = secrets;
    this._globalState = globalState;
    this._extensionUri = extensionUri;

    this._panel.webview.html = this._getWebviewContent();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => {
        this._handleMessage(msg).catch((err: any) => {
          this._post({ type: 'error', message: `Internal error: ${err?.message ?? String(err)}` });
        });
      },
      null,
      this._disposables
    );
  }

  // ─── Message Handler ──────────────────────────────────────────────────────────

  private async _handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this._sendSettings();
        this._post({ type: 'historyLoaded', entries: this._getHistory() });
        // Populate model dropdown with live Copilot models
        getAvailableModels().then(models => {
          if (models.length > 0) { this._post({ type: 'modelsLoaded', models }); }
        }).catch(() => { /* silently ignore — static fallback options remain */ });
        break;

      case 'analyze':
        await this._runAnalysis(msg.repoUrl!, msg.githubToken);
        break;

      case 'browseLocalFolder':
        await this._browseLocalFolder();
        break;

      case 'analyzeLocal':
        if (msg.localPath) {
          await this._runLocalAnalysis(msg.localPath);
        }
        break;

      case 'analyzeLocalMulti':
        if (msg.localPaths?.length) {
          await this._runLocalMultiAnalysis(msg.localPaths);
        }
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

      case 'generateArchitecture':
        if (!this._lastAnalysis) {
          this._post({ type: 'archError', message: 'Please analyze a repository first.' });
          return;
        }
        await this._runArchitecture(this._lastAnalysis);
        break;

      case 'saveArchitecture':
        await this._saveArchitectureToFile(this._lastArchitecture);
        break;

      case 'generateSecurity':
        if (!this._lastAnalysis) {
          this._post({ type: 'secError', message: 'Please analyze a repository first.' });
          return;
        }
        await this._runSecurity(this._lastAnalysis);
        break;

      case 'saveSecurity':
        await this._saveSecurityToFile(this._lastSecurity);
        break;

      case 'generateCorrection':
        if (!this._lastAnalysis) {
          this._post({ type: 'corrError', message: 'Please analyze a repository or folder first.' });
          return;
        }
        await this._runCorrection(msg.scopeRepo);
        break;

      case 'saveCorrection':
        await this._saveCorrectionToFile(this._lastCorrection);
        break;

      case 'applyCorrection':
        await this._applyCorrection(msg.scopeRepo);
        break;

      case 'stopGeneration':
        this._cancellationSource?.cancel();
        this._post({ type: 'stopped' });
        break;

      case 'saveToken':
        if (msg.githubToken) {
          await this._secrets.store(TOKEN_SECRET_KEY, msg.githubToken);
          this._post({ type: 'tokenSaved' });
        }
        break;

      case 'validateToken':
        await this._validateToken(msg.githubToken, msg.repoUrl);
        break;

      case 'savePlan':
        await this._savePlanToFile(msg.plan ?? '');
        break;

      case 'changeModel': {
        const cfg = vscode.workspace.getConfiguration('migrationAssistant');
        await cfg.update('copilotModel', msg.model, vscode.ConfigurationTarget.Global);
        break;
      }

      case 'loadFromHistory':
        this._loadFromHistory(msg.historyId!);
        break;

      case 'removeFromHistory':
        this._removeFromHistory(msg.historyId!);
        break;

      case 'clearHistory':
        await this._globalState.update(HISTORY_KEY, []);
        this._post({ type: 'historyLoaded', entries: [] });
        break;

      case 'addToQueue':
        if (msg.queueUrls?.length) {
          await this._runQueue(msg.queueUrls, msg.githubToken, msg.targetStack!, msg.options!);
        }
        break;

      case 'debugError':
        await this._runDebugHelper(msg.errorMessage ?? '');
        break;

      case 'exportPlan':
        if (msg.exportFormat) {
          await this._exportPlan(msg.exportFormat);
        }
        break;

      case 'analyzeOrg':
        await this._runOrgAnalysis(msg.orgUrl!, msg.githubToken);
        break;

      case 'checkProgress':
        await this._runProgressCheck(msg.branch ?? '');
        break;

      case 'generateFilePreviews':
        await this._runFilePreviews(msg.targetStack!);
        break;

      case 'getExecSummary':
        await this._runExecSummary(msg.targetStack!);
        break;

      case 'generateReport':
        await this._generateReport(msg.targetStack!, msg.reportFormat ?? 'word');
        break;

      case 'generateJiraStories':
        await this._generateJiraStories(msg.targetStack!, msg.jiraConfig!);
        break;

      // Retry a single section that failed during plan generation
      case 'retrySection':
        if (msg.sectionHeading) {
          await this._retrySection(msg.sectionHeading);
        }
        break;

      case 'recommendStacks':
        await this._runStackRecommendations();
        break;

      case 'analyzeStackHealth':
        await this._runStackHealthAnalysis();
        break;

      case 'aiDetectStack':
        await this._runAIStackDetection();
        break;

      case 'chat':
        await this._runChat(msg.chatMessage ?? '');
        break;

      case 'clearChat':
        this._chatHistory = [];
        this._pendingStackChange = undefined;
        this._post({ type: 'chatCleared' });
        break;

      // User confirmed they want to apply the detected stack swap to the plan
      case 'applyStackChange':
        await this.applyPendingPlanPatch(msg.regenerate === true);
        break;

      case 'openSettings':
        vscode.commands.executeCommand('workbench.action.openSettings', 'migrationAssistant');
        break;
    }
  }

  // ─── Send Saved Settings ──────────────────────────────────────────────────────

  private async _sendSettings(): Promise<void> {
    const config = vscode.workspace.getConfiguration('migrationAssistant');
    // Load token from SecretStorage (encrypted), not plain settings
    const githubToken = await this._secrets.get(TOKEN_SECRET_KEY) ?? '';
    const copilotModel = config.get<string>('copilotModel', 'gpt-4o');
    this._post({ type: 'settingsLoaded', settings: { githubToken, copilotModel } });
  }

  // ─── Analysis ─────────────────────────────────────────────────────────────────

  private async _runAnalysis(repoUrl: string, githubToken?: string): Promise<void> {
    // Resolve token: UI input → SecretStorage → undefined
    const storedToken = await this._secrets.get(TOKEN_SECRET_KEY);
    const token = githubToken || storedToken || undefined;

    // If a new token was typed in the UI, persist it to SecretStorage automatically
    if (githubToken && githubToken !== storedToken) {
      await this._secrets.store(TOKEN_SECRET_KEY, githubToken);
    }

    // ── Cache check (enhancement #4) ────────────────────────────────────────
    const cached = this._getCachedAnalysis(repoUrl);
    if (cached) {
      this._lastAnalysis = cached.analysis;
      this._applyRoots = [];
      this._post({ type: 'analysisComplete', analysis: cached.analysis, canApply: false });
      this._post({ type: 'cacheHit', cachedAt: cached.timestamp });
      this._generateAndPostPresets(cached.analysis);
      return;
    }

    try {
      const analysis = await analyzeRepository(
        repoUrl,
        token,
        (message, step, total) => {
          this._post({ type: 'progress', message, step, totalSteps: total });
        }
      );

      this._setCachedAnalysis(repoUrl, analysis);
      this._lastAnalysis = analysis;
      this._applyRoots = []; // GitHub repos aren't on disk — code-apply unavailable
      this._post({ type: 'analysisComplete', analysis, canApply: false });
      this._generateAndPostPresets(analysis);
    } catch (err: any) {
      this._post({ type: 'error', message: err.message || String(err) });
    }
  }

  // ─── Local Folder Browsing ────────────────────────────────────────────────────

  /** Open a folder picker and report the code repositories found inside. */
  private async _browseLocalFolder(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Select project folder',
      title: 'Select the folder that contains your repositories',
    });
    if (!picked || picked.length === 0) { return; }

    const root = picked[0].fsPath;
    try {
      const { repos } = await scanLocalFolder(root);
      if (repos.length === 0) {
        this._post({ type: 'error', message: `No code repositories found in "${root}". Pick a folder that contains a project (package.json, pom.xml, go.mod, etc.) or repo subfolders.` });
        return;
      }
      this._post({ type: 'localReposFound', localRoot: root, localRepos: repos });
    } catch (err: any) {
      this._post({ type: 'error', message: err.message || String(err) });
    }
  }

  /** Analyze a repository that lives on the local filesystem. Not cached —
   *  local files change often and re-reading from disk is cheap. */
  private async _runLocalAnalysis(fsPath: string): Promise<void> {
    try {
      const analysis = await analyzeLocalRepository(
        fsPath,
        (message, step, total) => this._post({ type: 'progress', message, step, totalSteps: total })
      );
      this._lastAnalysis = analysis;
      this._applyRoots = [{ name: path.basename(fsPath), path: fsPath }];
      this._post({ type: 'analysisComplete', analysis, canApply: true });
      this._generateAndPostPresets(analysis);
    } catch (err: any) {
      this._post({ type: 'error', message: err.message || String(err) });
    }
  }

  /** Analyze several local repos together as one project. Not cached. */
  private async _runLocalMultiAnalysis(fsPaths: string[]): Promise<void> {
    try {
      const analysis = await analyzeLocalRepositories(
        fsPaths,
        (message, step, total) => this._post({ type: 'progress', message, step, totalSteps: total })
      );
      this._lastAnalysis = analysis;
      this._applyRoots = fsPaths.map((p) => ({ name: path.basename(p), path: p }));
      this._post({ type: 'analysisComplete', analysis, canApply: true });
      this._generateAndPostPresets(analysis);
    } catch (err: any) {
      this._post({ type: 'error', message: err.message || String(err) });
    }
  }

  /** Fire-and-forget: generate AI presets and send them to the webview. */
  private _generateAndPostPresets(analysis: RepoAnalysis): void {
    const cts = new vscode.CancellationTokenSource();
    generatePresets(analysis, cts.token)
      .then((presets) => {
        this._post({ type: 'presetsReady', presets });
      })
      .catch(() => {
        // Preset generation is best-effort — fall back to the static list silently
        this._post({ type: 'presetsError' });
      })
      .finally(() => cts.dispose());
  }

  // ─── Migration Plan ───────────────────────────────────────────────────────────

  /** Wires the agent-team events to webview messages and caches the discussion. */
  private _teamCallbacks(): TeamCallbacks {
    return {
      onTeamFormed: (agents) => this._post({ type: 'teamFormed', agents }),
      onAgentStart: (agent, phase) => this._post({
        type: 'agentMessageStart',
        agentId: agent.id,
        agentRole: agent.role,
        agentEmoji: agent.emoji,
        agentPhase: phase,
      }),
      onAgentChunk: (agentId, chunk) => this._post({ type: 'agentMessageChunk', agentId, chunk }),
      onAgentEnd: (agentId) => this._post({ type: 'agentMessageEnd', agentId }),
      onDiscussionComplete: (discussion) => { this._lastTeamDiscussion = discussion; },
    };
  }

  /** Team-event callbacks for the architecture (LLD) flow → arch-prefixed messages. */
  private _archTeamCallbacks(): TeamCallbacks {
    return {
      onTeamFormed: (agents) => this._post({ type: 'archTeamFormed', agents }),
      onAgentStart: (agent, phase) => this._post({
        type: 'archAgentMessageStart',
        agentId: agent.id,
        agentRole: agent.role,
        agentEmoji: agent.emoji,
        agentPhase: phase,
      }),
      onAgentChunk: (agentId, chunk) => this._post({ type: 'archAgentMessageChunk', agentId, chunk }),
      onAgentEnd: (agentId) => this._post({ type: 'archAgentMessageEnd', agentId }),
    };
  }

  // ─── Architecture / Low-Level Design Documentation ────────────────────────────

  private async _runArchitecture(analysis: RepoAnalysis): Promise<void> {
    // ── Security confirmation — generating the LLD sends code to Copilot ───────
    const choice = await vscode.window.showWarningMessage(
      `Generate architecture documentation?\n\n` +
      `This sends your analyzed source files, file tree and dependency names to GitHub Copilot ` +
      `to produce a deep low-level design document.`,
      { modal: true },
      'Send to Copilot',
      'Cancel'
    );
    if (choice !== 'Send to Copilot') {
      this._post({ type: 'stopped' });
      return;
    }

    this._cancellationSource?.cancel();
    this._cancellationSource = new vscode.CancellationTokenSource();
    const token = this._cancellationSource.token;

    // The LLD is far richer when the full codebase has been summarised. Run the
    // chunked analysis once if it hasn't happened yet (e.g. arch before plan).
    const sourceFileCount = analysis.keyFiles.filter((f) => f.type === 'source').length;
    if (!analysis.chunkSummaries?.length && sourceFileCount > 0) {
      const chunkTotal = Math.ceil(sourceFileCount / 10);
      this._post({ type: 'progress', message: `Analysing ${sourceFileCount} source files in ${chunkTotal} groups…`, step: 1, totalSteps: chunkTotal + 1 });
      const chunkSummaries = await analyzeFilesInChunks(
        analysis,
        (msg, done, total) => this._post({ type: 'progress', message: msg, step: done + 1, totalSteps: total + 1 }),
        token
      );
      analysis = { ...analysis, chunkSummaries };
      this._lastAnalysis = analysis;
    }

    this._lastArchitecture = '';
    this._post({ type: 'archChunk', chunk: '' }); // clear signal

    try {
      const failedSections = await streamArchitectureDoc(
        analysis,
        (chunk) => {
          this._lastArchitecture += chunk;
          this._post({ type: 'archChunk', chunk });
        },
        token,
        (index, total, heading) => {
          this._post({ type: 'archSectionProgress', sectionIndex: index, sectionTotal: total, sectionHeading: heading });
        },
        this._archTeamCallbacks()
      );
      this._post({ type: 'archComplete', failedSections });
    } catch (err: any) {
      if (token.isCancellationRequested) {
        this._post({ type: 'stopped' });
      } else {
        this._post({ type: 'archError', message: err.message || String(err) });
      }
    }
  }

  private async _saveArchitectureToFile(doc: string): Promise<void> {
    if (!doc.trim()) {
      this._post({ type: 'archError', message: 'No architecture document to save.' });
      return;
    }
    const repo = this._lastAnalysis?.repoInfo.repo ?? 'project';
    const defaultUri = vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', `${repo}-architecture.md`));
    const uri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { Markdown: ['md'], Text: ['txt'] },
      saveLabel: 'Save Architecture Doc',
    });
    if (uri) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(doc, 'utf-8'));
      this._post({ type: 'architectureSaved' });
      vscode.window.showInformationMessage(`Architecture documentation saved to ${uri.fsPath}`);
    }
  }

  // ─── Security / Vulnerability Audit ───────────────────────────────────────────

  /** Team-event callbacks for the security flow → sec-prefixed messages. */
  private _secTeamCallbacks(): TeamCallbacks {
    return {
      onTeamFormed: (agents) => this._post({ type: 'secTeamFormed', agents }),
      onAgentStart: (agent, phase) => this._post({
        type: 'secAgentMessageStart',
        agentId: agent.id,
        agentRole: agent.role,
        agentEmoji: agent.emoji,
        agentPhase: phase,
      }),
      onAgentChunk: (agentId, chunk) => this._post({ type: 'secAgentMessageChunk', agentId, chunk }),
      onAgentEnd: (agentId) => this._post({ type: 'secAgentMessageEnd', agentId }),
    };
  }

  private async _runSecurity(analysis: RepoAnalysis): Promise<void> {
    // ── Security confirmation — auditing sends code to Copilot ─────────────────
    const choice = await vscode.window.showWarningMessage(
      `Run a whole-project security audit?\n\n` +
      `This sends your analyzed source files, file tree and dependency names to GitHub Copilot ` +
      `so a team of security analysts can find and triage vulnerabilities.`,
      { modal: true },
      'Send to Copilot',
      'Cancel'
    );
    if (choice !== 'Send to Copilot') {
      this._post({ type: 'stopped' });
      return;
    }

    this._cancellationSource?.cancel();
    this._cancellationSource = new vscode.CancellationTokenSource();
    const token = this._cancellationSource.token;

    // The audit is far more accurate with the full codebase summarised. Run the
    // chunked analysis once if it hasn't happened yet.
    const sourceFileCount = analysis.keyFiles.filter((f) => f.type === 'source').length;
    if (!analysis.chunkSummaries?.length && sourceFileCount > 0) {
      const chunkTotal = Math.ceil(sourceFileCount / 10);
      this._post({ type: 'progress', message: `Analysing ${sourceFileCount} source files in ${chunkTotal} groups…`, step: 1, totalSteps: chunkTotal + 1 });
      const chunkSummaries = await analyzeFilesInChunks(
        analysis,
        (msg, done, total) => this._post({ type: 'progress', message: msg, step: done + 1, totalSteps: total + 1 }),
        token
      );
      analysis = { ...analysis, chunkSummaries };
      this._lastAnalysis = analysis;
    }

    this._lastSecurity = '';
    this._post({ type: 'secChunk', chunk: '' }); // clear signal

    try {
      const failedSections = await streamSecurityAudit(
        analysis,
        (chunk) => {
          this._lastSecurity += chunk;
          this._post({ type: 'secChunk', chunk });
        },
        token,
        (index, total, heading) => {
          this._post({ type: 'secSectionProgress', sectionIndex: index, sectionTotal: total, sectionHeading: heading });
        },
        this._secTeamCallbacks()
      );
      this._post({ type: 'secComplete', failedSections });
    } catch (err: any) {
      if (token.isCancellationRequested) {
        this._post({ type: 'stopped' });
      } else {
        this._post({ type: 'secError', message: err.message || String(err) });
      }
    }
  }

  private async _saveSecurityToFile(doc: string): Promise<void> {
    if (!doc.trim()) {
      this._post({ type: 'secError', message: 'No security report to save.' });
      return;
    }
    const repo = this._lastAnalysis?.repoInfo.repo ?? 'project';
    const defaultUri = vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', `${repo}-security-report.md`));
    const uri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { Markdown: ['md'], Text: ['txt'] },
      saveLabel: 'Save Security Report',
    });
    if (uri) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(doc, 'utf-8'));
      this._post({ type: 'securitySaved' });
      vscode.window.showInformationMessage(`Security report saved to ${uri.fsPath}`);
    }
  }

  // ─── Behavior-Preserving Correction ───────────────────────────────────────────

  /** Team-event callbacks for the correction flow → corr-prefixed messages. */
  private _corrTeamCallbacks(): TeamCallbacks {
    return {
      onTeamFormed: (agents) => this._post({ type: 'corrTeamFormed', agents }),
      onAgentStart: (agent, phase) => this._post({
        type: 'corrAgentMessageStart',
        agentId: agent.id,
        agentRole: agent.role,
        agentEmoji: agent.emoji,
        agentPhase: phase,
      }),
      onAgentChunk: (agentId, chunk) => this._post({ type: 'corrAgentMessageChunk', agentId, chunk }),
      onAgentEnd: (agentId) => this._post({ type: 'corrAgentMessageEnd', agentId }),
    };
  }

  /** Run the correction team on the whole project or a single focused sub-repo. */
  private async _runCorrection(scopeRepo?: string): Promise<void> {
    let analysis = this._lastAnalysis!;
    const focused = !!(scopeRepo && analysis.subRepos?.includes(scopeRepo));
    if (focused) {
      analysis = focusAnalysisOnSubRepo(analysis, scopeRepo!);
    }

    const scopeName = focused ? `the "${scopeRepo}" repository` : 'the whole project';
    const choice = await vscode.window.showWarningMessage(
      `Generate a behavior-preserving correction plan for ${scopeName}?\n\n` +
      `A team of engineers will study the code and propose structural/quality fixes only — ` +
      `no business logic will be changed. Your source files are sent to GitHub Copilot.`,
      { modal: true },
      'Send to Copilot',
      'Cancel'
    );
    if (choice !== 'Send to Copilot') {
      this._post({ type: 'stopped' });
      return;
    }

    this._cancellationSource?.cancel();
    this._cancellationSource = new vscode.CancellationTokenSource();
    const token = this._cancellationSource.token;

    // Ensure the full-codebase summaries exist for the (possibly focused) analysis.
    const sourceFileCount = analysis.keyFiles.filter((f) => f.type === 'source').length;
    if (!analysis.chunkSummaries?.length && sourceFileCount > 0) {
      const chunkTotal = Math.ceil(sourceFileCount / 10);
      this._post({ type: 'progress', message: `Analysing ${sourceFileCount} source files in ${chunkTotal} groups…`, step: 1, totalSteps: chunkTotal + 1 });
      const chunkSummaries = await analyzeFilesInChunks(
        analysis,
        (msg, done, total) => this._post({ type: 'progress', message: msg, step: done + 1, totalSteps: total + 1 }),
        token
      );
      analysis = { ...analysis, chunkSummaries };
      // Only cache back onto the shared analysis when not focused (focused is a slice)
      if (!focused) { this._lastAnalysis = analysis; }
    }

    this._lastCorrection = '';
    this._post({ type: 'corrChunk', chunk: '' }); // clear signal

    try {
      const failedSections = await streamCorrectionPlan(
        analysis,
        (chunk) => {
          this._lastCorrection += chunk;
          this._post({ type: 'corrChunk', chunk });
        },
        token,
        (index, total, heading) => {
          this._post({ type: 'corrSectionProgress', sectionIndex: index, sectionTotal: total, sectionHeading: heading });
        },
        this._corrTeamCallbacks()
      );
      this._post({ type: 'corrComplete', failedSections });
    } catch (err: any) {
      if (token.isCancellationRequested) {
        this._post({ type: 'stopped' });
      } else {
        this._post({ type: 'corrError', message: err.message || String(err) });
      }
    }
  }

  /**
   * Apply the correction in place: back up each target folder, then rewrite its
   * source files preserving behavior. Local-only; files with secrets and oversized
   * files are skipped; a global cap bounds the number of rewrites per run.
   */
  private async _applyCorrection(scopeRepo?: string): Promise<void> {
    if (!this._lastAnalysis) {
      this._post({ type: 'applyError', message: 'Analyze a folder first.' });
      return;
    }
    if (this._applyRoots.length === 0) {
      this._post({ type: 'applyError', message: 'Apply only works on locally-analyzed folders (not GitHub URLs). Use 📁 Browse Local Folder.' });
      return;
    }
    if (!this._lastCorrection.trim()) {
      this._post({ type: 'applyError', message: 'Generate a correction plan first, then apply it.' });
      return;
    }

    let roots = this._applyRoots;
    if (scopeRepo) { roots = roots.filter((r) => r.name === scopeRepo); }
    if (roots.length === 0) {
      this._post({ type: 'applyError', message: `Couldn't find the local path for "${scopeRepo}".` });
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      `Apply corrections to ${roots.length} folder(s)?\n\n${roots.map((r) => r.path).join('\n')}\n\n` +
      `• A backup copy of each folder is made first (excludes node_modules/.git).\n` +
      `• Full file contents are sent to GitHub Copilot to be rewritten.\n` +
      `• Only structure/quality changes — behavior is preserved — but you MUST review the diff and run your tests afterward.`,
      { modal: true },
      'Backup & Apply',
      'Cancel'
    );
    if (choice !== 'Backup & Apply') {
      this._post({ type: 'stopped' });
      return;
    }

    this._cancellationSource?.cancel();
    this._cancellationSource = new vscode.CancellationTokenSource();
    const token = this._cancellationSource.token;

    const MAX_TOTAL = 60; // bound the number of rewrites per apply run
    const backups: string[] = [];
    const changed: string[] = [];
    let attempts = 0;

    try {
      for (const root of roots) {
        if (token.isCancellationRequested) { break; }
        this._post({ type: 'applyProgress', message: `Backing up ${root.name}…` });
        backups.push(await backupRepoFolder(root.path));

        const focused = this._lastAnalysis.subRepos?.includes(root.name)
          ? focusAnalysisOnSubRepo(this._lastAnalysis, root.name)
          : this._lastAnalysis;
        const secretFiles = focused.redactionSummary.filesWithSecrets;
        const isSecret = (rel: string) => secretFiles.some((s) => s === rel || s.endsWith('/' + rel));
        const sourceFiles = focused.keyFiles.filter((f) => f.type === 'source').map((f) => f.path);

        for (let i = 0; i < sourceFiles.length; i++) {
          if (token.isCancellationRequested || attempts >= MAX_TOTAL) { break; }
          const rel = sourceFiles[i];
          this._post({ type: 'applyProgress', message: `[${root.name}] ${i + 1}/${sourceFiles.length}: ${rel}` });
          if (isSecret(rel)) { continue; } // never auto-edit files containing secrets
          const full = readRepoFileFull(root.path, rel);
          if (full === null) { continue; }
          attempts++;
          const updated = await rewriteFilePreservingBehavior(rel, full, this._lastCorrection, token);
          if (updated && updated !== full) {
            writeRepoFile(root.path, rel, updated);
            changed.push(`${root.name}/${rel}`);
          }
        }
      }
      this._post({ type: 'applyComplete', appliedFiles: changed, backupPaths: backups });
    } catch (err: any) {
      if (token.isCancellationRequested) {
        this._post({ type: 'applyComplete', appliedFiles: changed, backupPaths: backups });
      } else {
        this._post({ type: 'applyError', message: err.message || String(err) });
      }
    }
  }

  private async _saveCorrectionToFile(doc: string): Promise<void> {
    if (!doc.trim()) {
      this._post({ type: 'corrError', message: 'No correction plan to save.' });
      return;
    }
    const repo = this._lastAnalysis?.repoInfo.repo ?? 'project';
    const defaultUri = vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', `${repo}-correction-plan.md`));
    const uri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { Markdown: ['md'], Text: ['txt'] },
      saveLabel: 'Save Correction Plan',
    });
    if (uri) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(doc, 'utf-8'));
      this._post({ type: 'correctionSaved' });
      vscode.window.showInformationMessage(`Correction plan saved to ${uri.fsPath}`);
    }
  }

  private async _runMigrationPlan(
    analysis: RepoAnalysis,
    targetStack: string,
    options: AnalysisOptions
  ): Promise<void> {
    // ── Security confirmation before any code leaves the machine ──────────────
    const { redactionSummary, repoInfo, keyFiles } = analysis;
    const isEnterprise = !repoInfo.owner.includes('github.com'); // non-public host
    const filesSent = keyFiles.map((f) => f.path).join(', ');

    const confirmLines: string[] = [
      `The following will be sent to GitHub Copilot:`,
      `• ${keyFiles.length} file(s): ${filesSent}`,
      `• File tree (sensitive paths excluded)`,
      `• Dependency names and versions`,
    ];
    if (redactionSummary.totalRedactions > 0) {
      confirmLines.push(`• ⚠️ ${redactionSummary.totalRedactions} secret(s) were auto-redacted (shown as [REDACTED])`);
    }
    if (redactionSummary.skippedFiles.length > 0) {
      confirmLines.push(`• 🚫 ${redactionSummary.skippedFiles.length} sensitive file(s) were blocked from being read`);
    }
    if (isEnterprise) {
      confirmLines.push(`\n⚠️  This appears to be an enterprise/internal repository. Ensure your Copilot subscription does not retain prompts for training.`);
    }

    const choice = await vscode.window.showWarningMessage(
      confirmLines.join('\n'),
      { modal: true },
      'Send to Copilot',
      'Cancel'
    );

    if (choice !== 'Send to Copilot') {
      this._post({ type: 'stopped' });
      return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    this._cancellationSource?.cancel();
    this._cancellationSource = new vscode.CancellationTokenSource();
    const token = this._cancellationSource.token;

    // ── Chunked full-codebase analysis ────────────────────────────────────────
    // Analyse ALL fetched source files in groups of 10 before generating the
    // plan, so every section knows about the whole codebase — not just samples.
    const sourceFileCount = analysis.keyFiles.filter((f) => f.type === 'source').length;
    if (sourceFileCount > 0) {
      const chunkTotal = Math.ceil(sourceFileCount / 10);
      this._post({ type: 'progress', message: `Analysing ${sourceFileCount} source files in ${chunkTotal} groups…`, step: 1, totalSteps: chunkTotal + 1 });
      const chunkSummaries = await analyzeFilesInChunks(
        analysis,
        (msg, done, total) => this._post({ type: 'progress', message: msg, step: done + 1, totalSteps: total + 1 }),
        token
      );
      analysis = { ...analysis, chunkSummaries };
      this._lastAnalysis = analysis; // update so re-runs use the enriched version
    }
    // ─────────────────────────────────────────────────────────────────────────

    this._lastPlan = '';
    this._lastTargetStack = targetStack;
    this._lastOptions = options;
    this._chatHistory = []; // new plan = fresh chat context
    this._lastTeamDiscussion = undefined; // fresh team meeting for this run
    this._post({ type: 'planChunk', chunk: '' }); // clear signal

    try {
      const failedSections = await streamMigrationPlanTeam(
        analysis,
        targetStack,
        options,
        (chunk) => {
          this._lastPlan += chunk;
          this._post({ type: 'planChunk', chunk });
        },
        token,
        (index, total, heading) => {
          this._post({
            type: 'sectionProgress',
            sectionIndex: index,
            sectionTotal: total,
            sectionHeading: heading,
          });
        },
        this._teamCallbacks()
      );

      // ── Coherence check: validate the completed plan for contradictions,
      //    invented file paths, and version mismatches.
      //    The review is stored separately and NEVER merged into _lastPlan so
      //    exports, Jira stories, chat context, and history all stay clean.
      if (!token.isCancellationRequested) {
        try {
          let coherenceBuf = '';
          const coherenceHeading = '\n\n---\n\n## Plan Coherence Review\n\n';
          this._post({ type: 'planChunk', chunk: coherenceHeading });
          await streamCoherenceCheck(
            analysis,
            targetStack,
            this._lastPlan,
            (chunk) => {
              coherenceBuf += chunk;
              this._post({ type: 'planChunk', chunk });
            },
            token
          );
          this._coherenceReview = coherenceBuf;
          this._post({ type: 'coherenceReady', coherenceReview: coherenceBuf });
        } catch {
          // Coherence check is best-effort — silently skip on failure
        }
      }

      this._post({ type: 'planComplete', failedSections });
      const cfg = vscode.workspace.getConfiguration('migrationAssistant');
      await cfg.update('lastTargetStack', targetStack, vscode.ConfigurationTarget.Global);
      // Save to history (enhancement #9)
      await this._saveToHistory(analysis, targetStack, this._lastPlan);
      // Reload history in UI
      this._post({ type: 'historyLoaded', entries: this._getHistory() });
    } catch (err: any) {
      if (token.isCancellationRequested) {
        this._post({ type: 'stopped' });
      } else {
        this._post({ type: 'error', message: err.message || String(err) });
      }
    }
  }

  // ─── Cache (enhancement #4) ───────────────────────────────────────────────────

  private _getCachedAnalysis(repoUrl: string): CachedAnalysis | undefined {
    const all = this._globalState.get<Record<string, CachedAnalysis>>(CACHE_KEY, {});
    const entry = all[repoUrl];
    if (!entry) { return undefined; }
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
      delete all[repoUrl];
      this._globalState.update(CACHE_KEY, all);
      return undefined;
    }
    return entry;
  }

  private _setCachedAnalysis(repoUrl: string, analysis: RepoAnalysis): void {
    const all = this._globalState.get<Record<string, CachedAnalysis>>(CACHE_KEY, {});
    all[repoUrl] = { repoUrl, analysis, timestamp: Date.now() };
    this._globalState.update(CACHE_KEY, all);
  }

  // ─── History (enhancement #9) ─────────────────────────────────────────────────

  private _getHistory(): HistoryEntry[] {
    return this._globalState.get<HistoryEntry[]>(HISTORY_KEY, []);
  }

  private async _saveToHistory(analysis: RepoAnalysis, targetStack: string, plan: string): Promise<void> {
    const entries = this._getHistory();
    const entry: HistoryEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      repoUrl: `https://${analysis.repoInfo.hostname}/${analysis.repoInfo.owner}/${analysis.repoInfo.repo}`,
      owner: analysis.repoInfo.owner,
      repo: analysis.repoInfo.repo,
      targetStack,
      timestamp: Date.now(),
      plan,
      analysis,
    };
    entries.unshift(entry);
    await this._globalState.update(HISTORY_KEY, entries.slice(0, MAX_HISTORY));
  }

  private _loadFromHistory(id: string): void {
    const entry = this._getHistory().find((e) => e.id === id);
    if (!entry) { return; }
    this._lastPlan = entry.plan;
    this._lastAnalysis = entry.analysis; // restore so debug/exec-summary/progress-check work
    this._lastTargetStack = entry.targetStack;
    this._chatHistory = []; // fresh context for this history entry
    this._lastTeamDiscussion = undefined; // no cached discussion for a loaded plan → re-target convenes full team
    // Replay the plan as chunks so the UI renders it
    this._post({ type: 'planChunk', chunk: '' });
    this._post({ type: 'planChunk', chunk: entry.plan });
    this._post({ type: 'planComplete' });
  }

  private async _removeFromHistory(id: string): Promise<void> {
    const entries = this._getHistory().filter((e) => e.id !== id);
    await this._globalState.update(HISTORY_KEY, entries);
    this._post({ type: 'historyLoaded', entries });
  }

  // ─── Token Validation (enhancement #12) ──────────────────────────────────────

  private async _validateToken(githubToken?: string, repoUrl?: string): Promise<void> {
    const token = githubToken || await this._secrets.get(TOKEN_SECRET_KEY);
    if (!token) {
      this._post({ type: 'tokenValidation', isValid: false, message: 'No token provided.' });
      return;
    }
    try {
      const result = await this._githubUserCheck(token, repoUrl);
      this._post({ type: 'tokenValidation', isValid: true, username: result });
    } catch (err: any) {
      this._post({ type: 'tokenValidation', isValid: false, message: err.message });
    }
  }

  private async _githubUserCheck(token: string, repoUrl?: string): Promise<string> {
    const headers = {
      'User-Agent': 'vscode-migration-assistant/1.0',
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
    };
    const fetchJson = async (url: string) => {
      const res = await fetch(url, { headers });
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    };

    // 1️⃣ Try /user — works when the classic PAT has any read scope
    try {
      const { status, body } = await fetchJson('https://api.github.com/user');
      if (status === 200) { return (body.login as string) ?? 'authenticated'; }
    } catch { /* fall through */ }

    // 2️⃣ Try /rate_limit — works with any valid token regardless of scopes
    try {
      const { status, body } = await fetchJson('https://api.github.com/rate_limit');
      if (status === 200) {
        const core = (body as any)?.resources?.core as { limit?: number; remaining?: number } | undefined;
        const limit = core?.limit ?? 0;
        const remaining = core?.remaining ?? 0;
        if (limit >= 5000) {
          return `authenticated (${remaining}/${limit} requests remaining)`;
        }
      }
    } catch { /* fall through */ }

    // 3️⃣ Last resort — try the actual repo the user entered.
    //    This is exactly the endpoint the analysis uses, so if it works the token is fine.
    if (repoUrl) {
      try {
        const { parseGitHubUrl } = await import('./githubAnalyzer');
        const { owner, repo, hostname } = parseGitHubUrl(repoUrl);
        const apiBase = hostname === 'github.com' ? 'https://api.github.com' : `https://${hostname}/api/v3`;
        const { status } = await fetchJson(`${apiBase}/repos/${owner}/${repo}`);
        if (status === 200) {
          return `token works for ${owner}/${repo}`;
        }
      } catch { /* fall through */ }
    }

    throw new Error(
      'Could not verify token against GitHub API. ' +
      'If repository analysis works, your token is valid — ' +
      'your organisation may restrict the /user endpoint (SAML SSO or scope policy).'
    );
  }

  // ─── Save Plan as .md (enhancement #2) ───────────────────────────────────────

  private async _savePlanToFile(plan: string): Promise<void> {
    if (!plan.trim()) {
      this._post({ type: 'error', message: 'No plan to save.' });
      return;
    }
    const repo = this._lastAnalysis?.repoInfo.repo ?? 'migration';
    const defaultUri = vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', `${repo}-migration-plan.md`));
    const uri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { Markdown: ['md'], Text: ['txt'] },
      saveLabel: 'Save Migration Plan',
    });
    if (uri) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(plan, 'utf-8'));
      this._post({ type: 'planSaved' });
      vscode.window.showInformationMessage(`Migration plan saved to ${uri.fsPath}`);
    }
  }

  // ─── Multi-Repo Queue (enhancement #6) ───────────────────────────────────────

  private async _runQueue(urls: string[], githubToken: string | undefined, targetStack: string, options: AnalysisOptions): Promise<void> {
    const storedToken = await this._secrets.get(TOKEN_SECRET_KEY);
    const token = githubToken || storedToken || undefined;

    for (let i = 0; i < urls.length; i++) {
      const repoUrl = urls[i].trim();
      if (!repoUrl) { continue; }
      this._post({ type: 'queueProgress', queueIndex: i + 1, queueTotal: urls.length, queueRepo: repoUrl });
      try {
        const cached = this._getCachedAnalysis(repoUrl);
        const analysis = cached?.analysis ?? await analyzeRepository(
          repoUrl, token,
          (message, step, total) => this._post({ type: 'progress', message: `[${i + 1}/${urls.length}] ${message}`, step, totalSteps: total })
        );
        if (!cached) { this._setCachedAnalysis(repoUrl, analysis); }
        this._lastAnalysis = analysis;
        this._post({ type: 'analysisComplete', analysis });
        await this._runMigrationPlan(analysis, targetStack, options);
      } catch (err: any) {
        this._post({ type: 'error', message: `[${repoUrl}] ${err.message}` });
      }
    }
  }

  // ─── Debug Helper (enhancement #3) ───────────────────────────────────────────

  private async _runDebugHelper(errorMessage: string): Promise<void> {
    if (!this._lastAnalysis) {
      this._post({ type: 'error', message: 'Analyze a repository first so the debugger has context.' });
      return;
    }
    if (!errorMessage.trim()) {
      this._post({ type: 'error', message: 'Paste an error message to debug.' });
      return;
    }
    this._cancellationSource?.cancel();
    this._cancellationSource = new vscode.CancellationTokenSource();
    this._post({ type: 'debugChunk', chunk: '' });
    try {
      await streamDebugHelp(
        this._lastAnalysis, errorMessage,
        (chunk) => this._post({ type: 'debugChunk', chunk }),
        this._cancellationSource.token
      );
      this._post({ type: 'debugComplete' });
    } catch (err: any) {
      this._post({ type: 'error', message: err.message });
    }
  }

  // ─── Executive Summary (enhancement #5) ──────────────────────────────────────

  private async _runExecSummary(targetStack: string): Promise<void> {
    if (!this._lastAnalysis || !this._lastPlan) {
      this._post({ type: 'error', message: 'Generate a migration plan first.' });
      return;
    }
    this._cancellationSource?.cancel();
    this._cancellationSource = new vscode.CancellationTokenSource();
    this._post({ type: 'execSummaryChunk', chunk: '' });
    try {
      await streamExecSummary(
        this._lastAnalysis, targetStack, this._lastPlan,
        (chunk) => this._post({ type: 'execSummaryChunk', chunk }),
        this._cancellationSource.token
      );
      this._post({ type: 'execSummaryComplete' });
    } catch (err: any) {
      this._post({ type: 'error', message: err.message });
    }
  }

  // ─── File Previews (enhancement #1) ──────────────────────────────────────────

  private async _runFilePreviews(targetStack: string): Promise<void> {
    if (!this._lastAnalysis) {
      this._post({ type: 'error', message: 'Analyze a repository first.' });
      return;
    }
    this._cancellationSource?.cancel();
    this._cancellationSource = new vscode.CancellationTokenSource();
    this._post({ type: 'previewChunk', chunk: '' });
    try {
      await streamFilePreviews(
        this._lastAnalysis, targetStack,
        (chunk) => this._post({ type: 'previewChunk', chunk }),
        this._cancellationSource.token
      );
      this._post({ type: 'previewComplete' });
    } catch (err: any) {
      this._post({ type: 'error', message: err.message });
    }
  }

  // ─── Stack Recommendations ────────────────────────────────────────────────────

  private async _runStackRecommendations(): Promise<void> {
    if (!this._lastAnalysis) {
      this._post({ type: 'error', message: 'Analyze a repository first.' });
      return;
    }
    this._cancellationSource?.cancel();
    this._cancellationSource = new vscode.CancellationTokenSource();
    this._post({ type: 'stackRecsChunk', chunk: '' });
    try {
      await streamStackRecommendations(
        this._lastAnalysis,
        (chunk) => this._post({ type: 'stackRecsChunk', chunk }),
        this._cancellationSource.token
      );
      this._post({ type: 'stackRecsComplete' });
    } catch (err: any) {
      this._post({ type: 'error', message: err.message });
    }
  }

  // ─── AI Stack Detection ───────────────────────────────────────────────────────

  private async _runAIStackDetection(): Promise<void> {
    if (!this._lastAnalysis) { return; }
    this._cancellationSource?.cancel();
    this._cancellationSource = new vscode.CancellationTokenSource();
    try {
      const aiStack = await detectStackWithAI(this._lastAnalysis, this._cancellationSource.token);
      this._post({ type: 'aiStackDetected', aiStack });
    } catch {
      // Silent — fallback to rule-based stack already shown
    }
  }

  // ─── Stack Health Analysis ────────────────────────────────────────────────────

  private async _runStackHealthAnalysis(): Promise<void> {
    if (!this._lastAnalysis) {
      this._post({ type: 'error', message: 'Analyze a repository first.' });
      return;
    }
    this._cancellationSource?.cancel();
    this._cancellationSource = new vscode.CancellationTokenSource();
    this._post({ type: 'stackHealthChunk', chunk: '' });
    try {
      await streamStackHealthAnalysis(
        this._lastAnalysis,
        (chunk) => this._post({ type: 'stackHealthChunk', chunk }),
        this._cancellationSource.token
      );
      this._post({ type: 'stackHealthComplete' });
    } catch (err: any) {
      this._post({ type: 'error', message: err.message });
    }
  }

  // ─── Export Plan (enhancement #4) ────────────────────────────────────────────

  private async _exportPlan(format: import('./types').ExportFormat): Promise<void> {
    if (!this._lastPlan || !this._lastAnalysis) {
      this._post({ type: 'error', message: 'Generate a plan first.' });
      return;
    }
    // Exec summary is its own streaming flow
    if (format === 'exec-summary') {
      const config = vscode.workspace.getConfiguration('migrationAssistant');
      const targetStack = config.get<string>('lastTargetStack', 'target stack');
      await this._runExecSummary(targetStack);
      return;
    }
    this._cancellationSource?.cancel();
    this._cancellationSource = new vscode.CancellationTokenSource();
    this._post({ type: 'exportReady', exportFormat: format, exportContent: '' });
    const config2 = vscode.workspace.getConfiguration('migrationAssistant');
    const exportTargetStack = config2.get<string>('lastTargetStack', 'target stack');
    try {
      let content = '';
      await streamExportFormat(
        this._lastPlan, format,
        this._lastAnalysis.repoInfo.repo,
        exportTargetStack,
        (chunk) => { content += chunk; this._post({ type: 'exportReady', exportFormat: format, exportContent: content }); },
        this._cancellationSource.token
      );
    } catch (err: any) {
      this._post({ type: 'error', message: err.message });
    }
  }

  // ─── Org Dashboard (enhancement #7) ──────────────────────────────────────────

  private async _runOrgAnalysis(orgUrl: string, githubToken?: string): Promise<void> {
    const storedToken = await this._secrets.get(TOKEN_SECRET_KEY);
    const token = githubToken || storedToken || undefined;
    try {
      const dashboard = await analyzeOrg(
        orgUrl, token,
        (msg, done, total) => this._post({ type: 'progress', message: msg, step: done, totalSteps: total })
      );
      this._post({ type: 'orgDashboard', dashboard });
    } catch (err: any) {
      this._post({ type: 'error', message: err.message });
    }
  }

  // ─── Progress Check (enhancement #8) ─────────────────────────────────────────

  private async _runProgressCheck(compareBranch: string): Promise<void> {
    if (!this._lastAnalysis || !this._lastPlan) {
      this._post({ type: 'error', message: 'Analyze a repository and generate a plan first.' });
      return;
    }
    const { owner, repo, hostname } = this._lastAnalysis.repoInfo;
    const storedToken = await this._secrets.get(TOKEN_SECRET_KEY);
    const base = this._lastAnalysis.repoInfo.defaultBranch;
    const compare = compareBranch || 'HEAD';
    this._cancellationSource?.cancel();
    this._cancellationSource = new vscode.CancellationTokenSource();
    this._post({ type: 'progressChunk', chunk: '' });
    try {
      const diff = await fetchBranchDiff(owner, repo, base, compare, storedToken || undefined, hostname);
      const config = vscode.workspace.getConfiguration('migrationAssistant');
      const targetStack = config.get<string>('lastTargetStack', 'target stack');
      await streamProgressCheck(
        this._lastAnalysis, targetStack, this._lastPlan, diff,
        (chunk) => this._post({ type: 'progressChunk', chunk }),
        this._cancellationSource.token
      );
      this._post({ type: 'progressComplete' });
    } catch (err: any) {
      this._post({ type: 'error', message: err.message });
    }
  }

  // ─── Interactive Chat ─────────────────────────────────────────────────────────

  private async _runChat(question: string): Promise<void> {
    if (!this._lastPlan || !this._lastAnalysis) {
      this._post({ type: 'error', message: 'Generate a migration plan first before using the chat.' });
      return;
    }
    if (!question.trim()) { return; }

    // Push the user's message into history immediately
    this._chatHistory.push({ role: 'user', content: question, timestamp: Date.now() });

    this._cancellationSource?.cancel();
    this._cancellationSource = new vscode.CancellationTokenSource();

    const config = vscode.workspace.getConfiguration('migrationAssistant');
    const targetStack = config.get<string>('lastTargetStack', 'target stack');

    let replyBuffer = '';
    this._post({ type: 'chatChunk', chunk: '' }); // signal: new assistant turn starting

    try {
      await streamChatReply(
        this._lastAnalysis,
        this._lastPlan,
        targetStack,
        this._chatHistory,
        question,
        (chunk) => {
          replyBuffer += chunk;
          this._post({ type: 'chatChunk', chunk });
        },
        this._cancellationSource.token
      );
      // Persist the completed assistant reply in history
      this._chatHistory.push({ role: 'assistant', content: replyBuffer, timestamp: Date.now() });
      this._post({ type: 'chatComplete' });
    } catch (err: any) {
      if (this._cancellationSource.token.isCancellationRequested) {
        this._post({ type: 'chatComplete' });
      } else {
        // Remove the unanswered user message so history stays consistent
        this._chatHistory.pop();
        this._post({ type: 'error', message: err.message || String(err) });
        return;
      }
    }

    // ── Stack-change intent detection (runs silently after chat reply) ──────
    // Only check when there is a plan and the user's message is non-trivial
    if (this._lastPlan && question.length > 10 && !this._cancellationSource.token.isCancellationRequested) {
      try {
        const intentToken = new vscode.CancellationTokenSource();
        const intent = await detectStackChangeIntent(
          question,
          this._lastPlan,
          intentToken.token
        );
        intentToken.dispose();

        if (intent && intent.fromComponent && intent.toComponent) {
          this._pendingStackChange = intent;
          // Notify the UI so it can show a "Apply to plan" confirmation banner
          this._post({ type: 'stackChangeDetected', stackChangeIntent: intent });
        }
      } catch {
        // Intent detection is best-effort — never surface errors to the user
      }
    }
  }

  // ─── Apply Plan Patch ─────────────────────────────────────────────────────────

  public async applyPendingPlanPatch(regenerate = false): Promise<void> {
    const intent = this._pendingStackChange;
    if (!intent || !this._lastAnalysis || !this._lastPlan) {
      this._post({ type: 'error', message: 'No pending stack change to apply.' });
      return;
    }
    this._pendingStackChange = undefined;

    this._cancellationSource?.cancel();
    this._cancellationSource = new vscode.CancellationTokenSource();
    const token = this._cancellationSource.token;

    if (regenerate) {
      // ── Full plan regeneration ─────────────────────────────────────────────
      // Build an updated target stack string by substituting the old component.
      // If the old component appears in the target string, swap it in-place;
      // otherwise append a directive so the LLM knows about the change.
      const baseTarget = this._lastTargetStack ||
        vscode.workspace.getConfiguration('migrationAssistant').get<string>('lastTargetStack', '');
      const updatedTarget = baseTarget.toLowerCase().includes(intent.fromComponent.toLowerCase())
        ? baseTarget.replace(new RegExp(intent.fromComponent, 'gi'), intent.toComponent)
        : `${baseTarget} (replacing ${intent.fromComponent} with ${intent.toComponent})`;

      const options: AnalysisOptions = this._lastOptions ?? {
        includeTestMigration: true,
        includeCiMigration: true,
        includeDockerMigration: true,
        detailLevel: 'detailed',
        phasedMode: false,
        scope: 'full',
      };

      // Clear plan display and restart — chunk summaries are already cached,
      // so skip re-fetching; go straight to plan generation.
      this._lastPlan = '';
      this._lastTargetStack = updatedTarget;
      this._lastOptions = options;
      this._chatHistory = [];
      this._post({ type: 'planChunk', chunk: '' }); // clear signal

      try {
        const onChunkCb = (chunk: string) => {
          this._lastPlan += chunk;
          this._post({ type: 'planChunk', chunk });
        };
        const onSectionCb = (index: number, total: number, heading: string) => {
          this._post({ type: 'sectionProgress', sectionIndex: index, sectionTotal: total, sectionHeading: heading });
        };
        // Reuse the cached team discussion (codebase is unchanged — only the
        // target moved), so we run a lightweight re-targeting round instead of
        // convening the full meeting again. No cache → full team meeting.
        const regenFailed = this._lastTeamDiscussion
          ? await streamMigrationPlanTeamDelta(
              this._lastAnalysis, updatedTarget, baseTarget, options,
              onChunkCb, token, onSectionCb, this._teamCallbacks(), this._lastTeamDiscussion
            )
          : await streamMigrationPlanTeam(
              this._lastAnalysis, updatedTarget, options,
              onChunkCb, token, onSectionCb, this._teamCallbacks()
            );
        this._post({ type: 'planComplete', failedSections: regenFailed });
        const cfg = vscode.workspace.getConfiguration('migrationAssistant');
        await cfg.update('lastTargetStack', updatedTarget, vscode.ConfigurationTarget.Global);
        await this._saveToHistory(this._lastAnalysis, updatedTarget, this._lastPlan);
        this._post({ type: 'historyLoaded', entries: this._getHistory() });
      } catch (err: any) {
        if (token.isCancellationRequested) {
          this._post({ type: 'stopped' });
        } else {
          this._post({ type: 'error', message: err.message || String(err) });
        }
      }
      return;
    }

    // ── Surgical section patch (default) ──────────────────────────────────────
    // Signal the UI that the plan is being rewritten
    this._post({ type: 'planPatchChunk', chunk: '' });

    try {
      await streamPlanPatch(
        this._lastAnalysis,
        this._lastPlan,
        intent,
        (chunk) => this._post({ type: 'planPatchChunk', chunk }),
        (patchedPlan) => {
          const diff = this._diffStats(this._lastPlan, patchedPlan);
          this._lastPlan = patchedPlan;
          this._post({ type: 'planPatchComplete', patchedPlan });
          this._post({ type: 'planDiff', diffStats: diff });
        },
        token
      );
    } catch (err: any) {
      this._post({ type: 'error', message: err.message || String(err) });
    }
  }

  // ─── Retry a single failed section ───────────────────────────────────────────

  private async _retrySection(sectionHeading: string): Promise<void> {
    if (!this._lastAnalysis || !this._lastTargetStack) {
      this._post({ type: 'error', message: 'No active plan to retry sections for.' });
      return;
    }

    const analysis    = this._lastAnalysis;
    const targetStack = this._lastTargetStack;
    const options     = this._lastOptions ?? {
      includeTestMigration:  true,
      includeCiMigration:    true,
      includeDockerMigration: true,
      detailLevel:           'detailed' as const,
      phasedMode:            false,
      scope:                 'full'    as const,
    };

    this._cancellationSource?.cancel();
    this._cancellationSource = new vscode.CancellationTokenSource();
    const token = this._cancellationSource.token;

    // Stream the retried section content via the patch channel so the webview
    // can replace the existing failed block without clearing the full plan.
    this._post({ type: 'planPatchChunk', chunk: '' }); // empty chunk = patch starting

    let retryContent = '';
    try {
      const ok = await streamSingleSection(
        analysis, targetStack, options, sectionHeading,
        (chunk) => {
          retryContent += chunk;
          this._post({ type: 'planPatchChunk', chunk });
        },
        token
      );

      if (ok) {
        // Locate the failed section in the stored plan and replace from its heading
        // through the failure-notice line with the fresh content.
        const failureMarker = '> **⚠️ This section could not be generated.**';
        // Match heading line(s) + anything up to and including the warning blockquote
        const escaped = sectionHeading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(
          `(##+ \\d+\\.?[^\\n]*${escaped}[^\\n]*)([\\s\\S]*?)` +
          `${failureMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*\\n?`,
          'i'
        );
        const patchedPlan = this._lastPlan.replace(pattern, `$1\n\n${retryContent}\n`);
        const oldPlan = this._lastPlan;
        this._lastPlan = patchedPlan !== this._lastPlan
          ? patchedPlan
          : this._lastPlan + `\n\n${retryContent}\n`; // fallback: append
        const retryDiff = this._diffStats(oldPlan, this._lastPlan);
        this._post({ type: 'planPatchComplete', patchedPlan: this._lastPlan });
        this._post({ type: 'planDiff', diffStats: retryDiff });
      } else {
        this._post({ type: 'error', message: `Could not regenerate section "${sectionHeading}". Try again later.` });
      }
    } catch (err: any) {
      this._post({ type: 'error', message: `Retry failed: ${err.message || String(err)}` });
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  /** Line-level diff — returns +/- counts and list of changed section headings. */
  private _diffStats(before: string, after: string): { added: number; removed: number; sections: string[] } {
    const oldLines = new Set(before.split('\n'));
    const newLines = after.split('\n');
    let added = 0, removed = 0;
    const changedSections: string[] = [];
    let currentSection = '';
    for (const line of newLines) {
      const hm = line.match(/^#{1,3} .+/);
      if (hm) { currentSection = line.replace(/^#+\s*/, '').trim(); }
      if (!oldLines.has(line)) {
        added++;
        if (currentSection && !changedSections.includes(currentSection)) {
          changedSections.push(currentSection);
        }
      }
    }
    const newLineSet = new Set(newLines);
    for (const line of before.split('\n')) {
      if (!newLineSet.has(line)) { removed++; }
    }
    return { added, removed, sections: changedSections };
  }

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

  // ─── Detailed Report Generation ───────────────────────────────────────────────

  private async _generateReport(targetStack: string, format: 'word' | 'html'): Promise<void> {
    if (!this._lastAnalysis) {
      this._post({ type: 'error', message: 'Analyze a repository first.' });
      return;
    }

    const resolvedTarget = targetStack ||
      (vscode.workspace.getConfiguration('migrationAssistant').get<string>('lastTargetStack') ?? 'modern stack');

    this._post({ type: 'progress', message: 'Generating detailed report via Copilot…', step: 1, totalSteps: 3 });

    this._cancellationSource?.cancel();
    this._cancellationSource = new vscode.CancellationTokenSource();
    const token = this._cancellationSource.token;

    let fullReport = '';
    let reportChunkCount = 0;
    try {
      await streamDetailedReport(
        this._lastAnalysis,
        resolvedTarget,
        (chunk) => {
          fullReport += chunk;
          // Animate progress bar as content streams in (step 1 of 3 = 0–33%)
          reportChunkCount++;
          if (reportChunkCount % 5 === 0) {
            const pct = Math.min(30, reportChunkCount * 0.3);
            this._post({ type: 'progress', message: `Receiving report content… (${fullReport.length} chars)`, step: pct, totalSteps: 100 });
          }
        },
        token
      );
    } catch (err: any) {
      this._post({ type: 'reportError', message: err.message || String(err) });
      return;
    }

    // Guard: reject suspiciously short or refusal-only content before writing
    const stripped = fullReport.replace(/\s+/g, ' ').trim();
    if (stripped.length < 300 || /sorry[\s,]+i[\s\u2019\u0027]+can[\s\u2019\u0027]+t\s+assist|cannot assist with that|i'?m not able to help|i'?m unable to (assist|generate|provide)/i.test(stripped)) {
      this._post({ type: 'reportError', message: 'Copilot declined to generate the report content. Try a different model or simplify the analysis.' });
      return;
    }

    this._post({ type: 'progress', message: 'Building document…', step: 60, totalSteps: 100 });

    try {
      let fileBuffer: Uint8Array;
      let defaultName: string;
      let filters: Record<string, string[]>;

      if (format === 'word') {
        const buf = await generateWordReport(fullReport, this._lastAnalysis, resolvedTarget);
        fileBuffer = new Uint8Array(buf);
        defaultName = `${this._lastAnalysis.repoInfo.repo}-migration-report.docx`;
        filters = { 'Word Document': ['docx'] };
      } else {
        const html = generateHtmlReport(fullReport, this._lastAnalysis, resolvedTarget);
        fileBuffer = new Uint8Array(Buffer.from(html, 'utf8'));
        defaultName = `${this._lastAnalysis.repoInfo.repo}-migration-report.html`;
        filters = { 'HTML Report': ['html'] };
      }

      const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(defaultName),
        filters,
        saveLabel: 'Save Report',
      });

      if (saveUri) {
        await vscode.workspace.fs.writeFile(saveUri, fileBuffer);
        this._post({ type: 'progress', message: `Report saved: ${saveUri.fsPath}`, step: 100, totalSteps: 100 });
        this._post({ type: 'reportReady', message: saveUri.fsPath });
        vscode.window.showInformationMessage(
          `Migration report saved: ${path.basename(saveUri.fsPath)}`,
          'Open'
        ).then(action => {
          if (action === 'Open') {
            vscode.env.openExternal(saveUri);
          }
        });
      }
    } catch (err: any) {
      this._post({ type: 'reportError', message: err.message || String(err) });
    }
  }

  // ─── Jira Stories Generation ────────────────────────────────────────────────

  private async _generateJiraStories(targetStack: string, config: JiraStoriesConfig): Promise<void> {
    if (!this._lastAnalysis || !this._lastPlan) {
      this._post({ type: 'error', message: 'Generate a migration plan first.' });
      return;
    }

    const resolvedTarget = targetStack ||
      (vscode.workspace.getConfiguration('migrationAssistant').get<string>('lastTargetStack') ?? 'modern stack');

    this._cancellationSource?.cancel();
    this._cancellationSource = new vscode.CancellationTokenSource();
    const token = this._cancellationSource.token;

    try {
      const stories = await streamJiraStories(
        this._lastAnalysis,
        resolvedTarget,
        this._lastPlan,
        config,
        (chunk) => { this._post({ type: 'jiraStoriesChunk', chunk }); },
        token
      );

      // Build CSV for Jira import
      const csvRows = [
        ['Summary', 'Issue Type', 'Priority', 'Story Points', 'Sprint', 'Labels', 'Component', 'Description', 'Acceptance Criteria', 'Estimated Days', 'Epic Name', 'Suggestions'].join(','),
      ];
      for (const s of stories) {
        csvRows.push([
          this._csvEscape(s.summary),
          'Story',
          s.priority,
          String(s.storyPoints),
          this._csvEscape(s.sprint),
          this._csvEscape(s.labels.join(';')),
          this._csvEscape(s.component),
          this._csvEscape(s.description),
          this._csvEscape(s.acceptanceCriteria),
          String(s.estimatedDays),
          this._csvEscape(s.epicName),
          this._csvEscape(s.suggestions),
        ].join(','));
      }

      const csvContent = csvRows.join('\n');
      this._post({ type: 'jiraStoriesCsv', csvContent });
      this._post({ type: 'jiraStoriesComplete' });
    } catch (err: any) {
      this._post({ type: 'error', message: `Jira stories error: ${err.message || String(err)}` });
      this._post({ type: 'jiraStoriesComplete' });
    }
  }

  private _csvEscape(value: string): string {
    const v = value.replace(/\r?\n/g, ' ').replace(/"/g, '""');
    return `"${v}"`;
  }

  // ─── Webview HTML ─────────────────────────────────────────────────────────────

  private _getWebviewContent(): string {
    // Locally-bundled mermaid (lazy-loaded in the webview only when diagrams exist)
    const mermaidUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js')
    );
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

  /* ── Stack Health ── */
  .health-summary {
    font-size: 12px;
    font-weight: 600;
    padding: 8px 10px;
    border-radius: var(--radius);
    margin-bottom: 8px;
    background: var(--vscode-editor-inactiveSelectionBackground);
    border: 1px solid var(--vscode-panel-border);
  }
  .health-cards { display: flex; flex-direction: column; gap: 6px; }
  .health-card {
    border-radius: var(--radius);
    padding: 9px 11px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    border-left: 3px solid transparent;
  }
  .health-card.impact-high   { border-left-color: #f44336; background: rgba(244,67,54,0.07); }
  .health-card.impact-medium { border-left-color: #ff9800; background: rgba(255,152,0,0.07); }
  .health-card.impact-low    { border-left-color: #4caf50; background: rgba(76,175,80,0.07); }
  .health-card-title { font-weight: 600; font-size: 12px; }
  .health-impact {
    font-size: 10px;
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 8px;
    display: inline-block;
    margin-left: 6px;
  }
  .health-card.impact-high   .health-impact { background:#f44336; color:#fff; }
  .health-card.impact-medium .health-impact { background:#ff9800; color:#fff; }
  .health-card.impact-low    .health-impact { background:#4caf50; color:#fff; }
  .health-problem { font-size: 11px; color: var(--vscode-foreground); opacity: 0.9; }
  .health-fix {
    font-size: 11px;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-inactiveSelectionBackground);
    border-radius: 4px;
    padding: 4px 7px;
    border-left: 2px solid var(--vscode-focusBorder);
  }
  .health-fix::before { content: '→ '; font-weight: 600; }

  /* ── Stack Recommendation Cards ── */
  .rec-cards { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
  .rec-card {
    background: var(--vscode-editor-inactiveSelectionBackground);
    border: 1px solid var(--vscode-panel-border);
    border-radius: var(--radius);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .rec-card-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .rec-title { font-weight: 600; font-size: 12px; flex: 1; }
  .effort-badge {
    font-size: 10px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 10px;
    white-space: nowrap;
  }
  .effort-low    { background: #2d6a2d; color: #c8e6c9; }
  .effort-medium { background: #7a5500; color: #fff3cd; }
  .effort-high   { background: #7a2020; color: #ffcdd2; }
  .effort-very-high { background: #5a0a5a; color: #f3e5f5; }
  .rec-bestfor { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 0; }
  .rec-body { font-size: 11px; line-height: 1.5; }
  .rec-body ul { margin: 2px 0; padding-left: 16px; }
  .rec-body li { margin: 1px 0; }
  .rec-use-btn { margin-top: 4px; align-self: flex-start; }
  .recs-loading { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 6px 0; }

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

  /* ── Grouped tab dropdowns ── */
  .tab-group { position: relative; display: inline-flex; }
  .tab-group-trigger {
    padding: 8px 14px; font-size: 12px; cursor: pointer;
    border: none; border-bottom: 2px solid transparent;
    color: var(--vscode-descriptionForeground);
    background: none; font-family: inherit; transition: color 0.15s;
  }
  .tab-group-trigger:hover { color: var(--vscode-foreground); }
  .tab-group-trigger.has-active {
    color: var(--vscode-foreground);
    border-bottom-color: var(--vscode-focusBorder);
  }
  .tab-menu {
    position: absolute; top: 100%; left: 0; z-index: 50;
    display: none; flex-direction: column; min-width: 180px;
    background: var(--vscode-dropdown-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border);
    border-radius: 0 0 6px 6px;
    box-shadow: 0 6px 16px rgba(0,0,0,0.35);
    padding: 4px;
  }
  .tab-group.open .tab-menu { display: flex; }
  .tab-menu .tab {
    width: 100%; text-align: left; padding: 7px 10px;
    border-bottom: none; border-radius: 4px;
  }
  .tab-menu .tab:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.06)); }
  .tab-menu .tab.active {
    background: var(--vscode-list-activeSelectionBackground, rgba(255,255,255,0.10));
    color: var(--vscode-foreground); border-bottom-color: transparent;
  }

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

  /* ── TOC panel ── */
  #plan-toc { background: var(--vscode-sideBar-background); }
  #plan-toc a {
    display: block; padding: 3px 12px; font-size: 11px; text-decoration: none;
    color: var(--vscode-descriptionForeground); border-left: 2px solid transparent;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  #plan-toc a:hover { color: var(--vscode-foreground); }
  #plan-toc a.toc-active {
    color: var(--vscode-foreground); border-left-color: var(--vscode-focusBorder);
    background: var(--vscode-list-hoverBackground);
  }
  #plan-toc li.toc-h2 a { padding-left: 12px; }
  #plan-toc li.toc-h3 a { padding-left: 24px; font-size: 10px; }

  /* ── Streaming cursor ── */
  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
  .stream-cursor {
    display: inline-block; width: 2px; height: 1em;
    background: var(--vscode-foreground); margin-left: 2px;
    vertical-align: text-bottom; animation: blink 1s step-start infinite;
  }

  /* ── Code blocks (parseMarkdown output) ── */
  .code-wrap {
    position: relative;
    margin: 10px 0;
    border-radius: var(--radius);
    border: 1px solid var(--vscode-panel-border);
    overflow: hidden;
  }
  .code-label {
    display: flex;
    align-items: center;
    padding: 5px 12px;
    font-family: var(--vscode-font-family, sans-serif);
    font-size: 11px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: .05em;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-editor-inactiveSelectionBackground);
    border-bottom: 1px solid var(--vscode-panel-border);
    user-select: none;
  }
  .code-copy-btn {
    margin-left: auto;
    padding: 2px 9px;
    font-size: 10px;
    cursor: pointer;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-font-family, sans-serif);
  }
  .code-copy-btn:hover { background: var(--vscode-button-secondaryHoverBackground); color: var(--vscode-button-foreground); }
  .code-wrap pre {
    margin: 0 !important;
    padding: 12px 14px !important;
    border: none !important;
    border-radius: 0 !important;
    background: var(--vscode-textCodeBlock-background) !important;
    overflow-x: auto;
  }
  .code-wrap pre code {
    background: none !important;
    padding: 0 !important;
    font-size: 12px;
    line-height: 1.65;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  /* Syntax token colors (VS Code dark theme defaults) */
  .tok-kw  { color: #569cd6; font-weight: 600; }
  .tok-str { color: #ce9178; }
  .tok-num { color: #b5cea8; }
  .tok-cmt { color: #6a9955; font-style: italic; }
  .tok-dec { color: #dcdcaa; }

  /* ── Chat ── */
  #tab-chat {
    display: none;
    flex-direction: column;
    height: 100%;
    padding: 0;
    overflow: hidden;
  }
  #tab-chat.active { display: flex; }

  .chat-thread {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .chat-bubble {
    max-width: 85%;
    padding: 9px 13px;
    border-radius: 12px;
    font-size: 12px;
    line-height: 1.6;
    word-break: break-word;
  }
  .chat-bubble.user {
    align-self: flex-end;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-bottom-right-radius: 3px;
  }
  .chat-bubble.assistant {
    align-self: flex-start;
    background: var(--vscode-editor-inactiveSelectionBackground);
    border: 1px solid var(--vscode-panel-border);
    border-bottom-left-radius: 3px;
  }
  .chat-bubble.assistant h1,
  .chat-bubble.assistant h2,
  .chat-bubble.assistant h3 { margin: 10px 0 5px; font-weight: 600; }
  .chat-bubble.assistant h1 { font-size: 14px; }
  .chat-bubble.assistant h2 { font-size: 13px; }
  .chat-bubble.assistant h3 { font-size: 12px; }
  .chat-bubble.assistant p  { margin: 4px 0; }
  .chat-bubble.assistant ul,
  .chat-bubble.assistant ol { padding-left: 18px; margin: 4px 0; }
  .chat-bubble.assistant li { margin: 2px 0; }
  .chat-bubble.assistant code {
    background: var(--vscode-textCodeBlock-background);
    padding: 1px 4px;
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
  }
  .chat-bubble.assistant pre {
    background: var(--vscode-textCodeBlock-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    padding: 8px;
    overflow-x: auto;
    margin: 6px 0;
    font-size: 11px;
  }
  .chat-bubble.assistant pre code { background: none; padding: 0; }
  .chat-bubble.assistant table {
    border-collapse: collapse; width: 100%; font-size: 11px; margin: 6px 0;
  }
  .chat-bubble.assistant th,
  .chat-bubble.assistant td {
    border: 1px solid var(--vscode-panel-border); padding: 4px 8px;
  }
  .chat-bubble.assistant th { background: var(--vscode-editor-inactiveSelectionBackground); font-weight: 600; }
  .chat-bubble.assistant strong { font-weight: 600; }
  .chat-bubble.assistant em { font-style: italic; }
  .chat-bubble.assistant blockquote {
    border-left: 2px solid var(--vscode-focusBorder);
    margin: 4px 0; padding: 2px 10px;
    color: var(--vscode-descriptionForeground);
  }

  .chat-role-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.55;
    margin-bottom: 3px;
  }
  .chat-msg-wrap { display: flex; flex-direction: column; }
  .chat-msg-wrap.user { align-items: flex-end; }
  .chat-msg-wrap.assistant { align-items: flex-start; }

  .chat-input-area {
    flex-shrink: 0;
    border-top: 1px solid var(--vscode-panel-border);
    padding: 10px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--vscode-editor-background);
  }
  .chat-input-row {
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }
  #chat-input {
    flex: 1;
    resize: none;
    min-height: 38px;
    max-height: 120px;
    overflow-y: auto;
    font-size: 12px;
    line-height: 1.5;
  }
  .chat-send-btn {
    flex-shrink: 0;
    width: auto;
    padding: 7px 14px;
    font-size: 12px;
  }
  .chat-actions-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .chat-hint {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    opacity: 0.7;
  }
  .chat-typing {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    padding: 4px 0;
  }

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
  .msg-info {
    background: var(--vscode-inputValidation-infoBackground, #e8f4fd);
    border: 1px solid var(--vscode-inputValidation-infoBorder, #2196f3);
    color: var(--vscode-foreground);
    border-radius: var(--radius);
    padding: 8px 12px;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
  }

  /* ── Stack-change confirmation banner ── */
  .stack-change-banner {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    background: var(--vscode-inputValidation-infoBackground, #1e3a4a);
    border: 1px solid var(--vscode-inputValidation-infoBorder, #2196f3);
    border-left: 4px solid var(--vscode-inputValidation-infoBorder, #2196f3);
    border-radius: var(--radius);
    padding: 10px 12px;
    margin: 8px 0;
    font-size: 12px;
    line-height: 1.5;
    animation: fadeIn 0.2s ease;
  }
  .stack-change-banner .banner-icon { font-size: 16px; flex-shrink: 0; padding-top: 1px; }
  .stack-change-banner .banner-body { flex: 1; }
  .stack-change-banner .banner-title { font-weight: 600; margin-bottom: 4px; }
  .stack-change-banner .banner-reason { color: var(--vscode-descriptionForeground); margin-bottom: 8px; font-style: italic; }
  .stack-change-banner .banner-scope-note { color: var(--vscode-editorWarning-foreground, #cca700); margin-bottom: 8px; font-size: 11px; }
  .stack-change-banner .banner-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .stack-change-banner .banner-apply {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; border-radius: 3px;
    padding: 4px 12px; cursor: pointer; font-size: 12px;
  }
  .stack-change-banner .banner-apply:hover { background: var(--vscode-button-hoverBackground); }
  .stack-change-banner .banner-apply.banner-secondary {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #cccccc);
  }
  .stack-change-banner .banner-apply.banner-secondary:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  .stack-change-banner .banner-dismiss {
    background: transparent;
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-widget-border, #555);
    border-radius: 3px; padding: 4px 10px; cursor: pointer; font-size: 12px;
  }
  .stack-change-banner .banner-dismiss:hover { color: var(--vscode-foreground); }

  /* ── Plan patch progress ── */
  .plan-patch-indicator {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 10px;
    background: var(--vscode-inputValidation-infoBackground, #1e3a4a);
    border-radius: var(--radius);
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 4px;
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

  /* ── Agent team discussion ── */
  .team-roster {
    display: flex; flex-wrap: wrap; gap: 8px;
    padding: 12px; margin-bottom: 14px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    background: var(--vscode-editor-inactiveSelectionBackground);
  }
  .team-roster-title {
    width: 100%; font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: .04em; opacity: .65; margin-bottom: 2px;
  }
  .team-chip {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 10px; border-radius: 14px; font-size: 12px;
    background: var(--vscode-badge-background, rgba(255,255,255,0.08));
    color: var(--vscode-badge-foreground, inherit);
  }
  .team-chip .em { font-size: 14px; }
  .agent-msg {
    display: flex; gap: 10px; margin: 0 0 14px; align-items: flex-start;
    animation: agent-in .25s ease;
  }
  @keyframes agent-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  .agent-avatar {
    flex-shrink: 0; width: 30px; height: 30px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; font-size: 16px;
    background: var(--vscode-editor-inactiveSelectionBackground);
    border: 1px solid var(--vscode-panel-border);
  }
  .agent-body {
    flex: 1; min-width: 0;
    background: var(--vscode-textBlockQuote-background, rgba(255,255,255,0.03));
    border-left: 2px solid var(--vscode-focusBorder);
    border-radius: 0 6px 6px 0; padding: 8px 12px;
  }
  .agent-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .agent-name { font-weight: 600; font-size: 12px; }
  .agent-phase {
    font-size: 9px; text-transform: uppercase; letter-spacing: .04em;
    padding: 1px 6px; border-radius: 8px; opacity: .8;
    background: var(--vscode-badge-background, rgba(255,255,255,0.08));
  }
  .agent-phase.synthesis { background: var(--vscode-button-background, #0e639c); color: #fff; opacity: 1; }
  .agent-text { font-size: 13px; line-height: 1.5; }
  .agent-text p:last-child { margin-bottom: 0; }
  .synthesis-progress {
    display: flex; flex-direction: column; gap: 8px;
    padding: 14px; margin: 4px 0 14px;
    border: 1px dashed var(--vscode-panel-border); border-radius: 8px;
  }
  .synthesis-progress .sp-row { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; }
  .synthesis-progress .sp-bar { height: 5px; border-radius: 3px; background: var(--vscode-input-background, rgba(255,255,255,0.08)); overflow: hidden; }
  .synthesis-progress .sp-fill { height: 100%; width: 0; background: var(--vscode-button-background, #0e639c); transition: width .3s ease; }

  /* ── Mermaid diagrams ── */
  .mermaid-wrap .mermaid-render {
    display: flex; justify-content: center; padding: 14px;
    background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.03));
    border-radius: 0 0 6px 6px; overflow: auto;
  }
  .mermaid-wrap .mermaid-render svg { max-width: 100%; height: auto; }
  .mermaid-wrap .mmd-pending { font-size: 12px; opacity: 0.6; padding: 10px; }
</style>
</head>
<body>

<!-- Header -->
<div class="header">
  <span class="header-icon">🚀</span>
  <h1>Code Migration Assistant</h1>
  <div class="header-actions">
    <select id="model-picker" title="Copilot Model" style="font-size:11px;padding:2px 4px;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border);border-radius:4px;cursor:pointer">
      <option value="gpt-4o">gpt-4o</option>
      <option value="gpt-4">gpt-4</option>
      <option value="gpt-3.5-turbo">gpt-3.5-turbo</option>
      <option value="claude-3.5-sonnet">claude-3.5-sonnet</option>
    </select>
    <button class="icon-btn" id="btn-save-md" title="Save plan as .md" disabled>💾</button>
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
        <div style="display:flex;gap:6px;align-items:center">
          <input id="input-token" type="password" placeholder="ghp_…" style="flex:1" />
          <button class="copy-btn" id="btn-validate-token" title="Verify token against GitHub API">Verify</button>
        </div>
        <div id="token-status" style="font-size:11px;margin-top:3px;display:none"></div>
      </div>
      <div id="cache-notice" style="display:none;font-size:11px;color:var(--vscode-descriptionForeground);margin-top:6px;padding:4px 8px;background:var(--vscode-editor-inactiveSelectionBackground);border-radius:4px">
        ⚡ Loaded from cache — <button onclick="bypassCache()" style="background:none;border:none;color:var(--vscode-textLink-foreground);cursor:pointer;font-size:11px;padding:0">re-fetch</button>
      </div>
      <button class="btn btn-primary" id="btn-analyze" style="margin-top:10px">
        🔍 Analyze Repository
      </button>
      <div style="display:flex;align-items:center;gap:8px;margin:10px 0;opacity:0.5;font-size:11px">
        <hr style="flex:1;border:none;border-top:1px solid var(--vscode-panel-border)"> or <hr style="flex:1;border:none;border-top:1px solid var(--vscode-panel-border)">
      </div>
      <button class="btn" id="btn-browse-local" style="width:100%;border:1px solid var(--vscode-button-border,var(--vscode-panel-border));background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)">
        📁 Browse Local Folder
      </button>
      <div id="local-repos" style="display:none;margin-top:8px">
        <div class="section-title" style="margin-bottom:4px;display:flex;justify-content:space-between;align-items:center">
          <span>Local repositories <span id="local-root" style="opacity:0.6;font-weight:400;text-transform:none"></span></span>
          <label style="font-weight:400;text-transform:none;display:flex;align-items:center;gap:3px;cursor:pointer"><input type="checkbox" id="local-select-all"> all</label>
        </div>
        <div style="font-size:11px;opacity:0.6;margin-bottom:4px">Click a repo to analyze it, or tick several and analyze them as one project.</div>
        <div id="local-repos-list" style="display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto"></div>
        <button id="btn-analyze-multi" class="btn btn-primary" style="margin-top:6px;display:none" disabled>🔗 Analyze selected together</button>
      </div>
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
        <label style="display:flex;align-items:center;gap:6px">
          Quick Presets
          <span id="preset-loading" style="display:none;font-size:10px;color:var(--vscode-descriptionForeground)">
            <span class="dot-pulse" style="display:inline-flex;gap:2px"><span></span><span></span><span></span></span>
            AI generating…
          </span>
          <span id="preset-ai-badge" style="display:none;font-size:10px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:8px;padding:1px 6px">✨ AI</span>
        </label>
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

      <div class="field" style="margin-top:8px">
        <label for="scope-select">Scope</label>
        <select id="scope-select">
          <option value="full" selected>Full migration</option>
          <option value="dependencies">Dependencies only</option>
          <option value="api">API / Routes layer</option>
          <option value="database">Database / ORM layer</option>
          <option value="config">Config files only</option>
          <option value="docker">Docker / Container only</option>
          <option value="ci">CI/CD only</option>
        </select>
      </div>


      <button class="btn btn-primary" id="btn-generate" style="margin-top:10px" disabled>
        ✨ Generate Migration Plan
      </button>
      <button class="btn btn-danger" id="btn-stop" style="margin-top:6px; display:none">
        ⏹ Stop Generation
      </button>
      <button class="btn btn-secondary" id="btn-suggest" style="margin-top:6px" disabled>
        💡 Suggest Migration Targets
      </button>
    </div>

    <!-- AI Target Recommendations -->
    <div id="recs-section" style="display:none">
      <hr style="border:none;border-top:1px solid var(--vscode-panel-border); margin-bottom:10px">
      <div class="section-title">AI-Recommended Migration Targets</div>
      <div id="recs-loading" class="recs-loading" style="display:none">Analyzing your stack…</div>
      <div id="recs-cards" class="rec-cards"></div>
    </div>

    <!-- Detected Stack (shown after analysis) -->
    <div id="stack-section" style="display:none">
      <hr style="border:none;border-top:1px solid var(--vscode-panel-border); margin-bottom:10px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <div class="section-title" style="margin-bottom:0">Detected Stack</div>
        <button class="btn btn-secondary" id="btn-health" style="font-size:11px;padding:3px 8px">
          🔬 Analyze Health
        </button>
      </div>
      <div id="stack-ai-loading" style="display:none;font-size:11px;color:var(--vscode-descriptionForeground);padding:4px 0;display:none">
        ✨ AI is analyzing your stack…
      </div>
      <div class="stack-card" id="stack-card"></div>

      <!-- Health Results -->
      <div id="health-section" style="display:none;margin-top:10px">
        <div id="health-loading" class="recs-loading" style="display:none">Auditing your stack…</div>
        <div id="health-summary" class="health-summary" style="display:none"></div>
        <div id="health-cards" class="health-cards"></div>
      </div>
    </div>

    <!-- Queue Section (enhancement #6) -->
    <hr style="border:none;border-top:1px solid var(--vscode-panel-border)">
    <div>
      <div class="section-title">Multi-Repo Queue</div>
      <div class="field">
        <label for="queue-input">Repository URLs <span style="opacity:0.6">(one per line)</span></label>
        <textarea id="queue-input" rows="3" placeholder="https://github.com/org/repo1&#10;https://github.com/org/repo2"></textarea>
      </div>
      <button class="btn btn-secondary" id="btn-run-queue" style="margin-top:6px" disabled>
        ▶ Run Queue
      </button>
      <div id="queue-status" style="display:none;font-size:11px;margin-top:6px;color:var(--vscode-descriptionForeground)"></div>
    </div>

    <!-- History Section (enhancement #9) -->
    <hr style="border:none;border-top:1px solid var(--vscode-panel-border)">
    <div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div class="section-title" style="margin-bottom:0">History</div>
        <button class="copy-btn" id="btn-clear-history" style="font-size:10px">Clear</button>
      </div>
      <div id="history-list" style="display:flex;flex-direction:column;gap:4px">
        <div style="font-size:11px;color:var(--vscode-descriptionForeground)">No history yet.</div>
      </div>
    </div>

  </div>

  <!-- Content Area -->
  <div class="content">
    <div class="content-tabs">
      <button class="tab active" data-tab="plan">Plan</button>
      <button class="tab" data-tab="architecture">🏛️ Architecture</button>
      <button class="tab" data-tab="security-audit">🛡️ Vulnerabilities</button>
      <button class="tab" data-tab="correction">🔧 Correct</button>

      <div class="tab-group" id="group-insights">
        <button class="tab-group-trigger" data-group="group-insights">Insights ▾</button>
        <div class="tab-menu">
          <button class="tab" data-tab="files">Files</button>
          <button class="tab" data-tab="security">Security</button>
          <button class="tab" data-tab="raw">Raw</button>
        </div>
      </div>

      <div class="tab-group" id="group-tools">
        <button class="tab-group-trigger" data-group="group-tools">Tools ▾</button>
        <div class="tab-menu">
          <button class="tab" data-tab="chat">💬 Chat</button>
          <button class="tab" data-tab="previews">File Previews</button>
          <button class="tab" data-tab="debug">Debug</button>
          <button class="tab" data-tab="progress">Progress</button>
          <button class="tab" data-tab="org">Org Dashboard</button>
        </div>
      </div>
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
            Generating…
          </div>
          <div style="flex:1"></div>
          <div style="display:flex;gap:6px;align-items:center">
            <select id="export-format" class="copy-btn" style="cursor:pointer" title="Export plan">
              <option value="">Export as…</option>
              <option value="checklist">✅ Checklist</option>
              <option value="github-issue">🐙 GitHub Issue</option>
              <option value="exec-summary">📊 Exec Summary</option>
              <option value="confluence">📝 Confluence</option>
            </select>
            <button class="copy-btn" id="btn-previews" title="Generate migrated file previews" disabled>📄 Previews</button>
            <select id="report-format" class="copy-btn" style="cursor:pointer" title="Download detailed report">
              <option value="">⬇ Report…</option>
              <option value="word">📄 Word (.docx)</option>
              <option value="html">🌐 HTML / PDF</option>
            </select>
            <button class="copy-btn" id="btn-jira-stories" title="Generate Jira stories for this migration" disabled>🎫 Jira Stories</button>
            <button class="copy-btn" id="btn-copy">Copy</button>
            <button id="btn-toc-toggle" class="copy-btn" title="Toggle table of contents" style="display:none">☰ Contents</button>
          </div>
        </div>
        <div style="display:flex;flex:1;overflow:hidden">
          <div id="plan-toc" style="display:none;width:200px;flex-shrink:0;overflow-y:auto;border-right:1px solid var(--vscode-panel-border);padding:10px 0">
            <div style="padding:0 12px 6px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;opacity:.6;display:flex;align-items:center;justify-content:space-between">
              Contents
              <button id="btn-toc-close" style="background:none;border:none;cursor:pointer;opacity:.5;font-size:12px;line-height:1;padding:0">✕</button>
            </div>
            <ul id="toc-list" style="list-style:none;padding:0;margin:0"></ul>
          </div>
          <div id="plan-rendered" style="flex:1;overflow:auto"></div>
        </div>
      </div>
    </div>

    <!-- Architecture (LLD) Tab -->
    <div class="tab-content" id="tab-architecture">
      <div id="arch-empty" class="empty-state">
        <div class="empty-icon">🏛️</div>
        <div class="empty-title">No architecture doc yet</div>
        <div class="empty-sub">
          Analyze a repository, then click <strong>Generate Architecture</strong>. A team of engineering
          analysts will study the codebase, discuss how it fits together, and write a deep low-level design
          document a new developer can onboard from.
        </div>
        <button id="btn-generate-arch" class="btn btn-primary" style="margin-top:14px" disabled>🏛️ Generate Architecture</button>
      </div>
      <div id="arch-container" style="display:none; height:100%; flex-direction:column">
        <div class="plan-header">
          <div id="arch-gen-indicator" class="generating-indicator" style="display:none">
            <div class="dot-pulse"><span></span><span></span><span></span></div>
            Documenting…
          </div>
          <div style="flex:1"></div>
          <div style="display:flex;gap:6px;align-items:center">
            <button class="copy-btn" id="btn-arch-regenerate" title="Regenerate the architecture doc">↻ Regenerate</button>
            <button class="copy-btn" id="btn-arch-save" title="Save as Markdown" disabled>⬇ Save .md</button>
            <button class="copy-btn" id="btn-arch-copy" disabled>Copy</button>
            <button class="copy-btn" id="btn-arch-stop" style="display:none">■ Stop</button>
          </div>
        </div>
        <div id="arch-rendered" style="flex:1;overflow:auto"></div>
      </div>
    </div>

    <!-- Security / Vulnerability Audit Tab -->
    <div class="tab-content" id="tab-security-audit">
      <div id="sec-empty" class="empty-state">
        <div class="empty-icon">🛡️</div>
        <div class="empty-title">No security audit yet</div>
        <div class="empty-sub">
          Analyze a repository, then click <strong>Run Security Audit</strong>. A team of security
          analysts will hunt for vulnerabilities across the whole project, correlate their findings,
          and produce a severity-sorted report with where, why and how to fix each issue.
        </div>
        <button id="btn-generate-sec" class="btn btn-primary" style="margin-top:14px" disabled>🛡️ Run Security Audit</button>
      </div>
      <div id="sec-container" style="display:none; height:100%; flex-direction:column">
        <div class="plan-header">
          <div id="sec-gen-indicator" class="generating-indicator" style="display:none">
            <div class="dot-pulse"><span></span><span></span><span></span></div>
            Auditing…
          </div>
          <div id="sec-summary" style="display:none;gap:6px;align-items:center;flex-wrap:wrap"></div>
          <div style="flex:1"></div>
          <div style="display:flex;gap:6px;align-items:center">
            <button class="copy-btn" id="btn-sec-regenerate" title="Re-run the security audit">↻ Re-run</button>
            <button class="copy-btn" id="btn-sec-save" title="Save as Markdown" disabled>⬇ Save .md</button>
            <button class="copy-btn" id="btn-sec-copy" disabled>Copy</button>
            <button class="copy-btn" id="btn-sec-stop" style="display:none">■ Stop</button>
          </div>
        </div>
        <div id="sec-rendered" style="flex:1;overflow:auto"></div>
      </div>
    </div>

    <!-- Behavior-Preserving Correction Tab -->
    <div class="tab-content" id="tab-correction">
      <div id="corr-empty" class="empty-state">
        <div class="empty-icon">🔧</div>
        <div class="empty-title">No correction plan yet</div>
        <div class="empty-sub">
          Analyze a folder/repo, choose a scope, then click <strong>Generate Correction Plan</strong>.
          A large engineering team studies the code and proposes structure & quality fixes only —
          <strong>no business logic is changed</strong>. A Behavior-Preservation Guardian locks the
          invariants and gives you a checklist to prove it still works as-is.
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:14px;flex-wrap:wrap;justify-content:center">
          <label style="font-size:12px">Scope:
            <select id="corr-scope" class="copy-btn" style="cursor:pointer">
              <option value="">Whole project</option>
            </select>
          </label>
          <button id="btn-generate-corr" class="btn btn-primary" disabled>🔧 Generate Correction Plan</button>
        </div>
      </div>
      <div id="corr-container" style="display:none; height:100%; flex-direction:column">
        <div class="plan-header">
          <div id="corr-gen-indicator" class="generating-indicator" style="display:none">
            <div class="dot-pulse"><span></span><span></span><span></span></div>
            Correcting…
          </div>
          <div id="corr-scope-badge" style="display:none;font-size:11px;opacity:0.75"></div>
          <div style="flex:1"></div>
          <div style="display:flex;gap:6px;align-items:center">
            <select id="corr-scope-2" class="copy-btn" style="cursor:pointer" title="Scope"></select>
            <button class="copy-btn" id="btn-corr-apply" title="Back up the folder, then apply these corrections to your files" style="display:none;background:var(--vscode-button-background);color:var(--vscode-button-foreground)" disabled>🔧 Apply to code</button>
            <button class="copy-btn" id="btn-corr-regenerate" title="Re-run the correction team">↻ Re-run</button>
            <button class="copy-btn" id="btn-corr-save" title="Save as Markdown" disabled>⬇ Save .md</button>
            <button class="copy-btn" id="btn-corr-copy" disabled>Copy</button>
            <button class="copy-btn" id="btn-corr-stop" style="display:none">■ Stop</button>
          </div>
        </div>
        <div id="corr-rendered" style="flex:1;overflow:auto"></div>
      </div>
    </div>

    <!-- Chat Tab -->
    <div class="tab-content" id="tab-chat">
      <div id="chat-empty-state" class="empty-state" style="display:none">
        <div class="empty-icon">💬</div>
        <div class="empty-title">No plan yet</div>
        <div class="empty-sub">Generate a migration plan first, then come back here to ask follow-up questions.</div>
      </div>
      <!-- Stack-change confirmation banner (hidden until the extension detects an intent) -->
      <div id="stack-change-banner" class="stack-change-banner" style="display:none">
        <div class="banner-icon">🔄</div>
        <div class="banner-body">
          <div class="banner-title" id="stack-change-title"></div>
          <div class="banner-reason" id="stack-change-reason" style="display:none"></div>
          <div class="banner-scope-note" id="banner-scope-note" style="display:none"></div>
          <div class="banner-actions">
            <button class="banner-apply" id="btn-apply-stack-change">Update affected sections</button>
            <button class="banner-apply banner-secondary" id="btn-regenerate-plan" style="display:none">Regenerate full plan</button>
            <button class="banner-dismiss" id="btn-dismiss-stack-change">Dismiss</button>
          </div>
        </div>
      </div>
      <!-- Plan-patch progress indicator (shown while sections are being rewritten) -->
      <div id="plan-patch-indicator" class="plan-patch-indicator" style="display:none">
        <div class="dot-pulse"><span></span><span></span><span></span></div>
        Rewriting plan — <span id="plan-patch-status">updating affected sections…</span>
      </div>
      <div class="chat-thread" id="chat-thread"></div>
      <div class="chat-input-area">
        <div class="chat-input-row">
          <textarea id="chat-input" rows="2"
            placeholder="Ask anything about the migration plan… e.g. Why do we need to replace express? What's the risk of step 3?"
            disabled></textarea>
          <button class="btn btn-primary chat-send-btn" id="btn-chat-send" disabled>Send</button>
          <button class="btn btn-danger chat-send-btn" id="btn-chat-stop" style="display:none">⏹</button>
        </div>
        <div class="chat-actions-row">
          <span class="chat-hint" id="chat-hint">Generate a migration plan first to enable the chat.</span>
          <button class="copy-btn" id="btn-chat-clear" style="font-size:10px" disabled>Clear chat</button>
        </div>
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

    <!-- File Previews Tab (enhancement #1) -->
    <div class="tab-content" id="tab-previews">
      <div class="empty-state" id="previews-empty">
        <div class="empty-icon">📄</div>
        <div class="empty-title">No previews yet</div>
        <div class="empty-sub">Generate a plan then click <strong>📄 Previews</strong> to see your files migrated to the target stack.</div>
      </div>
      <div id="previews-container" style="display:none;height:100%;flex-direction:column">
        <div class="plan-header">
          <div id="previews-indicator" class="generating-indicator" style="display:none">
            <div class="dot-pulse"><span></span><span></span><span></span></div> Generating previews…
          </div>
          <div style="flex:1"></div>
          <button class="copy-btn" id="btn-copy-previews">Copy</button>
        </div>
        <div id="previews-rendered" style="flex:1;overflow:auto"></div>
      </div>
    </div>

    <!-- Debug Tab (enhancement #3) -->
    <div class="tab-content" id="tab-debug">
      <div style="display:flex;flex-direction:column;height:100%;gap:10px;padding-bottom:10px">
        <div>
          <div class="section-title" style="margin-bottom:6px">Paste your error or stack trace</div>
          <textarea id="debug-input" rows="5" placeholder="Paste error message, stack trace, or describe the problem…" style="width:100%;resize:vertical"></textarea>
          <div style="display:flex;gap:6px;margin-top:6px">
            <button class="btn btn-primary" id="btn-debug" style="flex:1">🔍 Debug with Repo Context</button>
            <button class="btn btn-danger" id="btn-stop-debug" style="display:none;flex:0 0 auto;width:auto;padding:7px 12px">⏹</button>
          </div>
          <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-top:4px">
            Requires an analyzed repository for context.
          </div>
        </div>
        <div style="flex:1;overflow:auto;border:1px solid var(--vscode-panel-border);border-radius:6px;padding:12px">
          <div id="debug-empty" style="color:var(--vscode-descriptionForeground);font-size:12px">Debug output will appear here…</div>
          <div id="debug-rendered" style="display:none"></div>
        </div>
      </div>
    </div>

    <!-- Org Dashboard Tab (enhancement #7) -->
    <div class="tab-content" id="tab-org">
      <div style="display:flex;flex-direction:column;height:100%;gap:10px">
        <div style="flex-shrink:0">
          <div class="section-title" style="margin-bottom:6px">Scan a GitHub Organization</div>
          <div style="display:flex;gap:6px">
            <input id="org-input" type="text" placeholder="https://github.com/myorg" style="flex:1" />
            <button class="btn btn-primary" id="btn-scan-org" style="width:auto;padding:7px 14px">Scan</button>
          </div>
          <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-top:4px">Scans up to 50 repos. Uses the token from Step 1.</div>
          <div id="org-progress" style="display:none;font-size:11px;margin-top:6px;color:var(--vscode-descriptionForeground)"></div>
        </div>
        <div id="org-empty" class="empty-state" style="flex:1">
          <div class="empty-icon">🏢</div>
          <div class="empty-title">No org scanned yet</div>
          <div class="empty-sub">Enter an org URL and click Scan to see all repos with stack detection and migration complexity.</div>
        </div>
        <div id="org-table-wrap" style="display:none;flex:1;overflow:auto">
          <div id="org-summary" style="font-size:12px;margin-bottom:10px;color:var(--vscode-descriptionForeground)"></div>
          <table id="org-table" style="width:100%;border-collapse:collapse;font-size:12px">
            <thead>
              <tr style="border-bottom:1px solid var(--vscode-panel-border)">
                <th style="text-align:left;padding:6px 8px">Repo</th>
                <th style="padding:6px 8px">Language</th>
                <th style="padding:6px 8px">Stack</th>
                <th style="padding:6px 8px">Stars</th>
                <th style="padding:6px 8px">Complexity</th>
                <th style="padding:6px 8px">Action</th>
              </tr>
            </thead>
            <tbody id="org-tbody"></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Progress Check Tab (enhancement #8) -->
    <div class="tab-content" id="tab-progress">
      <div style="display:flex;flex-direction:column;height:100%;gap:10px">
        <div style="flex-shrink:0">
          <div class="section-title" style="margin-bottom:6px">Check Migration Progress</div>
          <div class="field">
            <label for="progress-branch">Compare branch (your WIP branch)</label>
            <div style="display:flex;gap:6px">
              <input id="progress-branch" type="text" placeholder="feature/migration or HEAD~5" style="flex:1" />
              <button class="btn btn-primary" id="btn-check-progress" style="width:auto;padding:7px 14px">Check</button>
            </div>
          </div>
          <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-top:4px">
            Compares your WIP branch against the default branch using the generated migration plan as the baseline.
          </div>
        </div>
        <div id="progress-empty" class="empty-state" style="flex:1">
          <div class="empty-icon">📊</div>
          <div class="empty-title">No progress checked yet</div>
          <div class="empty-sub">Generate a plan first, then enter your WIP branch name to see what's done vs. what remains.</div>
        </div>
        <div id="progress-container" style="display:none;flex:1;overflow:auto">
          <div id="progress-indicator" class="generating-indicator" style="display:none;margin-bottom:8px">
            <div class="dot-pulse"><span></span><span></span><span></span></div> Checking progress…
          </div>
          <div id="progress-rendered"></div>
        </div>
      </div>
    </div>

    <!-- Export Tab content appears inline in plan tab via export-output -->
    <div id="export-output-wrap" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:var(--vscode-editor-background);z-index:100;padding:20px;display:none;flex-direction:column;gap:10px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <strong id="export-title">Export</strong>
        <div style="display:flex;gap:8px">
          <button class="copy-btn" id="btn-copy-export">Copy</button>
          <button class="copy-btn" id="btn-close-export">✕ Close</button>
        </div>
      </div>
      <div id="export-content" style="flex:1;overflow:auto;font-size:12px;background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:6px;padding:12px"></div>
    </div>

    <!-- Jira Stories Config Modal -->
    <div id="jira-config-modal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:200;display:none;align-items:center;justify-content:center">
      <div style="background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:10px;padding:24px;width:380px;max-width:90vw">
        <h3 style="margin:0 0 16px 0">🎫 Generate Jira Stories</h3>
        <div style="margin-bottom:12px">
          <label style="display:block;margin-bottom:4px;font-weight:600;font-size:12px">Team Size</label>
          <input type="number" id="jira-team-size" min="1" max="50" value="4" style="width:100%;padding:6px 10px;border-radius:4px;border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground)">
        </div>
        <div style="margin-bottom:16px">
          <label style="display:block;margin-bottom:6px;font-weight:600;font-size:12px">Team Roles</label>
          <div style="display:flex;flex-wrap:wrap;gap:6px">
            <label style="font-size:11px;display:flex;align-items:center;gap:4px"><input type="checkbox" class="jira-role-cb" value="Senior Developer" checked> Senior Dev</label>
            <label style="font-size:11px;display:flex;align-items:center;gap:4px"><input type="checkbox" class="jira-role-cb" value="Junior Developer" checked> Junior Dev</label>
            <label style="font-size:11px;display:flex;align-items:center;gap:4px"><input type="checkbox" class="jira-role-cb" value="QA Engineer"> QA</label>
            <label style="font-size:11px;display:flex;align-items:center;gap:4px"><input type="checkbox" class="jira-role-cb" value="DevOps Engineer"> DevOps</label>
            <label style="font-size:11px;display:flex;align-items:center;gap:4px"><input type="checkbox" class="jira-role-cb" value="Tech Lead"> Tech Lead</label>
            <label style="font-size:11px;display:flex;align-items:center;gap:4px"><input type="checkbox" class="jira-role-cb" value="Architect"> Architect</label>
          </div>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="copy-btn" id="jira-config-cancel">Cancel</button>
          <button class="btn btn-primary" id="jira-config-go" style="padding:6px 16px">Generate Stories</button>
        </div>
      </div>
    </div>

    <!-- Jira Stories Output Overlay -->
    <div id="jira-output-wrap" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:var(--vscode-editor-background);z-index:100;padding:20px;display:none;flex-direction:column;gap:10px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <strong>🎫 Jira Stories</strong>
        <div style="display:flex;gap:8px">
          <button class="copy-btn" id="btn-copy-jira">Copy Markdown</button>
          <button class="copy-btn" id="btn-csv-jira">⬇ Download CSV</button>
          <button class="copy-btn" id="btn-close-jira">✕ Close</button>
        </div>
      </div>
      <div id="jira-output" style="flex:1;overflow:auto;white-space:pre-wrap;font-size:12px;background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:6px;padding:12px"></div>
    </div>

    <!-- Security Report Tab (enhancement #11) -->
    <div class="tab-content" id="tab-security">
      <div class="empty-state" id="security-empty">
        <div class="empty-icon">🔒</div>
        <div class="empty-title">No analysis yet</div>
        <div class="empty-sub">Analyze a repository to see the security report.</div>
      </div>
      <div id="security-report" style="display:none;font-size:12px;line-height:1.7">
        <h3 style="margin-bottom:10px">Security Report</h3>
        <div id="security-content"></div>
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
const MERMAID_URI = "${mermaidUri}";

// ─── State ────────────────────────────────────────────────────────────────────
let planMarkdown = '';
let analysisData = null;
let isGenerating = false;
let lastRepoUrl   = '';

// ─── Agent team state ─────────────────────────────────────────────────────────
let teamMode = false;            // true while a multi-agent run is in progress
let teamAgents = [];             // roster for the current run
let agentBubbles = {};           // agentId -> { wrap, body, raw }
let teamTranscriptHTML = '';     // saved discussion markup for the post-run toggle

// ─── Architecture (LLD) state ─────────────────────────────────────────────────
let archMarkdown = '';           // accumulated LLD document
let archMode = false;            // true while the doc team is running
let archAgents = [];             // doc team roster
let archBubbles = {};            // agentId -> { wrap, body, raw }
let archTranscriptHTML = '';     // saved discussion markup for the toggle
let archGenerating = false;

// ─── Security audit state ─────────────────────────────────────────────────────
let secMarkdown = '';
let secMode = false;
let secAgents = [];
let secBubbles = {};
let secTranscriptHTML = '';
let secGenerating = false;

// ─── Correction state ─────────────────────────────────────────────────────────
let corrMarkdown = '';
let corrMode = false;
let corrAgents = [];
let corrBubbles = {};
let corrTranscriptHTML = '';
let corrGenerating = false;

// ─── Render Scheduler ─────────────────────────────────────────────────────────
// Throttle with leading + trailing fire.
//
// Problem with pure trailing debounce: the LLM streams chunks continuously,
// so a "cancel + reschedule on every chunk" timer NEVER fires while streaming.
//
// This implementation fires immediately on the first chunk (leading), then at
// most once per RENDER_INTERVAL_MS after that regardless of chunk rate. Each
// fn() closes over shared state (planMarkdown etc.) so it always reads the
// latest accumulated text when it executes.
const RENDER_INTERVAL_MS = 500; // Increased from 150 — parse+innerHTML on a large plan is ~20ms; 500ms gives breathing room
const _renderTimers  = Object.create(null); // key → setTimeout handle
const _lastRenderAt  = Object.create(null); // key → timestamp of last render

function scheduleRender(key, fn) {
  if (_renderTimers[key]) { return; } // timer already queued; it will read fresh state when it fires
  const elapsed = Date.now() - (_lastRenderAt[key] || 0);
  const delay   = Math.max(0, RENDER_INTERVAL_MS - elapsed); // 0 = fire immediately (leading)
  _renderTimers[key] = setTimeout(() => {
    delete _renderTimers[key];
    _lastRenderAt[key] = Date.now();
    fn();
  }, delay);
}

function flushRender(key, fn) {
  if (_renderTimers[key]) { clearTimeout(_renderTimers[key]); delete _renderTimers[key]; }
  _lastRenderAt[key] = Date.now();
  fn();
}

// ─── Element Refs ──────────────────────────────────────────────────────────────
const btnAnalyze       = document.getElementById('btn-analyze');
const btnBrowseLocal   = document.getElementById('btn-browse-local');
const localReposBox    = document.getElementById('local-repos');
const localReposList   = document.getElementById('local-repos-list');
const localRootLabel   = document.getElementById('local-root');
const localSelectAll   = document.getElementById('local-select-all');
const btnAnalyzeMulti  = document.getElementById('btn-analyze-multi');
const btnGenerate      = document.getElementById('btn-generate');
// Architecture tab
const archEmpty        = document.getElementById('arch-empty');
const archContainer    = document.getElementById('arch-container');
const archRendered     = document.getElementById('arch-rendered');
const btnGenerateArch  = document.getElementById('btn-generate-arch');
const btnArchSave      = document.getElementById('btn-arch-save');
const btnArchCopy      = document.getElementById('btn-arch-copy');
const btnArchStop      = document.getElementById('btn-arch-stop');
const btnArchRegen     = document.getElementById('btn-arch-regenerate');
const archGenIndicator = document.getElementById('arch-gen-indicator');
// Security tab
const secEmpty         = document.getElementById('sec-empty');
const secContainer     = document.getElementById('sec-container');
const secRendered      = document.getElementById('sec-rendered');
const secSummary       = document.getElementById('sec-summary');
const btnGenerateSec   = document.getElementById('btn-generate-sec');
const btnSecSave       = document.getElementById('btn-sec-save');
const btnSecCopy       = document.getElementById('btn-sec-copy');
const btnSecStop       = document.getElementById('btn-sec-stop');
const btnSecRegen      = document.getElementById('btn-sec-regenerate');
const secGenIndicator  = document.getElementById('sec-gen-indicator');
// Correction tab
const corrEmpty        = document.getElementById('corr-empty');
const corrContainer    = document.getElementById('corr-container');
const corrRendered     = document.getElementById('corr-rendered');
const corrScope        = document.getElementById('corr-scope');
const corrScope2       = document.getElementById('corr-scope-2');
const corrScopeBadge   = document.getElementById('corr-scope-badge');
const btnGenerateCorr  = document.getElementById('btn-generate-corr');
const btnCorrSave      = document.getElementById('btn-corr-save');
const btnCorrCopy      = document.getElementById('btn-corr-copy');
const btnCorrStop      = document.getElementById('btn-corr-stop');
const btnCorrRegen     = document.getElementById('btn-corr-regenerate');
const btnCorrApply     = document.getElementById('btn-corr-apply');
const corrGenIndicator = document.getElementById('corr-gen-indicator');
let corrCanApply = false;   // true when the analysis is local (writable on disk)
let corrApplying = false;
const btnStop          = document.getElementById('btn-stop');
const btnSuggest       = document.getElementById('btn-suggest');
const recsSection      = document.getElementById('recs-section');
const recsLoading      = document.getElementById('recs-loading');
const recsCards        = document.getElementById('recs-cards');
const btnHealth        = document.getElementById('btn-health');
const healthSection    = document.getElementById('health-section');
const healthLoading    = document.getElementById('health-loading');
const healthSummary    = document.getElementById('health-summary');
const healthCards      = document.getElementById('health-cards');
const btnSettings      = document.getElementById('btn-settings');
const btnCopy          = document.getElementById('btn-copy');
const btnSaveMd        = document.getElementById('btn-save-md');
const btnValidateToken = document.getElementById('btn-validate-token');
const btnRunQueue      = document.getElementById('btn-run-queue');
const btnClearHistory  = document.getElementById('btn-clear-history');
const modelPicker      = document.getElementById('model-picker');
const inputRepo        = document.getElementById('input-repo');
const inputToken       = document.getElementById('input-token');
const inputTarget      = document.getElementById('input-target');
const queueInput       = document.getElementById('queue-input');
const presetSelect     = document.getElementById('preset-select');
const presetLoading    = document.getElementById('preset-loading');
const presetAiBadge    = document.getElementById('preset-ai-badge');
const detailLevel      = document.getElementById('detail-level');
const optTests         = document.getElementById('opt-tests');
const optCi            = document.getElementById('opt-ci');
const optDocker        = document.getElementById('opt-docker');
const progressSect     = document.getElementById('progress-section');
const progressBar      = document.getElementById('progress-bar');
const progressText     = document.getElementById('progress-text');
const errorBox         = document.getElementById('error-box');
const cacheNotice      = document.getElementById('cache-notice');
const tokenStatus      = document.getElementById('token-status');
const stackSection     = document.getElementById('stack-section');
const stackCard        = document.getElementById('stack-card');
const stackAiLoading   = document.getElementById('stack-ai-loading');
const planEmpty        = document.getElementById('plan-empty');
const planContainer    = document.getElementById('plan-container');
const planRendered     = document.getElementById('plan-rendered');
      const planToc          = document.getElementById('plan-toc');
      const tocList          = document.getElementById('toc-list');
      const btnTocToggle     = document.getElementById('btn-toc-toggle');
const planOutput       = document.getElementById('plan-output');
const filesEmpty       = document.getElementById('files-empty');
const filesContainer   = document.getElementById('files-container');
const filesHeader      = document.getElementById('files-header');
const fileTreeCont     = document.getElementById('file-tree-content');
const rawEmpty         = document.getElementById('raw-empty');
const genIndicator     = document.getElementById('generating-indicator');
const securityEmpty    = document.getElementById('security-empty');
const securityReport   = document.getElementById('security-report');
const securityContent  = document.getElementById('security-content');
const historyList      = document.getElementById('history-list');
const queueStatus      = document.getElementById('queue-status');
// New tabs
const btnPreviews      = document.getElementById('btn-previews');
const previewsEmpty    = document.getElementById('previews-empty');
const previewsContainer= document.getElementById('previews-container');
const previewsRendered = document.getElementById('previews-rendered');
const previewsIndicator= document.getElementById('previews-indicator');
const btnCopyPreviews  = document.getElementById('btn-copy-previews');
const btnDebug         = document.getElementById('btn-debug');
const btnStopDebug     = document.getElementById('btn-stop-debug');
const debugInput       = document.getElementById('debug-input');
const debugEmpty       = document.getElementById('debug-empty');
const debugRendered    = document.getElementById('debug-rendered');
const exportFormat     = document.getElementById('export-format');
const reportFormatSel  = document.getElementById('report-format');
const exportOutputWrap = document.getElementById('export-output-wrap');
const exportContent    = document.getElementById('export-content');
const exportTitle      = document.getElementById('export-title');
const btnCopyExport    = document.getElementById('btn-copy-export');
const btnCloseExport   = document.getElementById('btn-close-export');
const orgInput         = document.getElementById('org-input');
const btnScanOrg       = document.getElementById('btn-scan-org');
const orgEmpty         = document.getElementById('org-empty');
const orgTableWrap     = document.getElementById('org-table-wrap');
const orgSummary       = document.getElementById('org-summary');
const orgTbody         = document.getElementById('org-tbody');
const orgProgress      = document.getElementById('org-progress');
const progressBranch   = document.getElementById('progress-branch');
const btnCheckProgress = document.getElementById('btn-check-progress');
const progressEmpty    = document.getElementById('progress-empty');
const progressContainer= document.getElementById('progress-container');
const progressRendered = document.getElementById('progress-rendered');
const progressIndicator= document.getElementById('progress-indicator');
const scopeSelect      = document.getElementById('scope-select');

const btnJiraStories   = document.getElementById('btn-jira-stories');
const jiraConfigModal  = document.getElementById('jira-config-modal');
const jiraTeamSizeInput= document.getElementById('jira-team-size');
const jiraConfigCancel = document.getElementById('jira-config-cancel');
const jiraConfigGo     = document.getElementById('jira-config-go');
const jiraOutputWrap   = document.getElementById('jira-output-wrap');
const jiraOutput       = document.getElementById('jira-output');
const btnCopyJira      = document.getElementById('btn-copy-jira');
const btnCsvJira       = document.getElementById('btn-csv-jira');
const btnCloseJira     = document.getElementById('btn-close-jira');
let jiraMarkdown       = '';
let jiraCsvContent     = '';
let previewsMarkdown   = '';
let exportMarkdown     = '';
let stackRecsMarkdown  = '';
let stackHealthMarkdown = '';

// ─── Chat State ────────────────────────────────────────────────────────────────
let chatReady     = false; // true once a plan has been generated
let chatReplying  = false; // true while streaming an assistant reply
let chatReplyBuf  = '';    // accumulates current assistant turn

const chatThread    = document.getElementById('chat-thread');
const chatInput     = document.getElementById('chat-input');
const btnChatSend   = document.getElementById('btn-chat-send');
const btnChatStop   = document.getElementById('btn-chat-stop');
const btnChatClear  = document.getElementById('btn-chat-clear');
const chatHint      = document.getElementById('chat-hint');
const chatEmptyState = document.getElementById('chat-empty-state');

// ─── Stack-change banner state ─────────────────────────────────────────────────
const stackChangeBanner    = document.getElementById('stack-change-banner');
const stackChangeTitle     = document.getElementById('stack-change-title');
const stackChangeReason    = document.getElementById('stack-change-reason');
const bannerScopeNote      = document.getElementById('banner-scope-note');
const planPatchIndicator   = document.getElementById('plan-patch-indicator');
const planPatchStatus      = document.getElementById('plan-patch-status');
const btnApplyStackChange  = document.getElementById('btn-apply-stack-change');
const btnRegeneratePlan    = document.getElementById('btn-regenerate-plan');
const btnDismissStackChange = document.getElementById('btn-dismiss-stack-change');

btnApplyStackChange.addEventListener('click', () => {
  stackChangeBanner.style.display = 'none';
  planPatchIndicator.style.display = 'flex';
  planPatchStatus.textContent = 'updating affected sections…';
  vscode.postMessage({ type: 'applyStackChange', regenerate: false });
});

btnRegeneratePlan.addEventListener('click', () => {
  stackChangeBanner.style.display = 'none';
  planPatchIndicator.style.display = 'flex';
  planPatchStatus.textContent = 'regenerating full plan…';
  vscode.postMessage({ type: 'applyStackChange', regenerate: true });
});

btnDismissStackChange.addEventListener('click', () => {
  stackChangeBanner.style.display = 'none';
});

// ─── Tab switching (with grouped dropdowns) ─────────────────────────────────────
function closeTabMenus() {
  document.querySelectorAll('.tab-group.open').forEach(g => g.classList.remove('open'));
}
// Highlight a group trigger when one of its items is the active tab.
function syncGroupTriggers() {
  document.querySelectorAll('.tab-group').forEach(g => {
    const trigger = g.querySelector('.tab-group-trigger');
    if (trigger) { trigger.classList.toggle('has-active', !!g.querySelector('.tab.active')); }
  });
}
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    closeTabMenus();
    syncGroupTriggers();
  });
});
// Dropdown triggers open/close their menu
document.querySelectorAll('.tab-group-trigger').forEach(trigger => {
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const group = trigger.closest('.tab-group');
    const wasOpen = group.classList.contains('open');
    closeTabMenus();
    if (!wasOpen) { group.classList.add('open'); }
  });
});
// Click outside closes any open menu
document.addEventListener('click', (e) => {
  if (!e.target.closest('.tab-group')) { closeTabMenus(); }
});

// ─── Chat ──────────────────────────────────────────────────────────────────────

function chatSend() {
  const text = chatInput.value.trim();
  if (!text || chatReplying || !chatReady) { return; }
  chatInput.value = '';
  chatInput.style.height = 'auto';
  appendChatBubble('user', text);
  startChatReply();
  vscode.postMessage({ type: 'chat', chatMessage: text });
}

function startChatReply() {
  chatReplying = true;
  chatReplyBuf = '';
  btnChatSend.style.display = 'none';
  btnChatStop.style.display = 'inline-flex';
  chatInput.disabled = true;
  btnChatClear.disabled = true;
  // Placeholder bubble that we'll fill in as chunks arrive
  const wrap = document.createElement('div');
  wrap.className = 'chat-msg-wrap assistant';
  wrap.id = 'chat-pending-wrap';
  const label = document.createElement('div');
  label.className = 'chat-role-label';
  label.textContent = 'Assistant';
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble assistant';
  bubble.id = 'chat-pending-bubble';
  bubble.innerHTML = \`<div class="chat-typing"><div class="dot-pulse"><span></span><span></span><span></span></div> Thinking…</div>\`;
  wrap.appendChild(label);
  wrap.appendChild(bubble);
  chatThread.appendChild(wrap);
  chatThread.scrollTop = chatThread.scrollHeight;
}

function stopChatReply() {
  chatReplying = false;
  btnChatSend.style.display = 'inline-flex';
  btnChatStop.style.display = 'none';
  chatInput.disabled = false;
  btnChatClear.disabled = false;
  chatInput.focus();
  // Remove pending bubble if it was never filled
  const pending = document.getElementById('chat-pending-wrap');
  if (pending && !chatReplyBuf) { pending.remove(); }
}

function appendChatBubble(role, text) {
  const wrap = document.createElement('div');
  wrap.className = \`chat-msg-wrap \${role}\`;
  const label = document.createElement('div');
  label.className = 'chat-role-label';
  label.textContent = role === 'user' ? 'You' : 'Assistant';
  const bubble = document.createElement('div');
  bubble.className = \`chat-bubble \${role}\`;
  bubble.innerHTML = role === 'user' ? escapeHtml(text) : parseMarkdown(text);
  wrap.appendChild(label);
  wrap.appendChild(bubble);
  chatThread.appendChild(wrap);
  chatThread.scrollTop = chatThread.scrollHeight;
}

function enableChat() {
  chatReady = true;
  chatInput.disabled = false;
  btnChatSend.disabled = false;
  btnChatClear.disabled = false;
  chatHint.textContent = 'Ask anything about the migration plan. Shift+Enter for new line.';
}

btnChatSend.addEventListener('click', chatSend);

btnChatStop.addEventListener('click', () => {
  vscode.postMessage({ type: 'stopGeneration' });
  stopChatReply();
});

btnChatClear.addEventListener('click', () => {
  chatThread.innerHTML = '';
  chatReplyBuf = '';
  stackChangeBanner.style.display = 'none';
  planPatchIndicator.style.display = 'none';
  vscode.postMessage({ type: 'clearChat' });
});

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    chatSend();
  }
});

// Auto-resize textarea
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
});

// ─── Model Picker (enhancement #10) ───────────────────────────────────────────
modelPicker.addEventListener('change', () => {
  vscode.postMessage({ type: 'changeModel', model: modelPicker.value });
});

// ─── Preset select ─────────────────────────────────────────────────────────────
presetSelect.addEventListener('change', () => {
  if (presetSelect.value) { inputTarget.value = presetSelect.value; presetSelect.value = ''; }
});

// ─── Settings ─────────────────────────────────────────────────────────────────
btnSettings.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));

// ─── Token Validation (enhancement #12) ──────────────────────────────────────
btnValidateToken.addEventListener('click', () => {
  const tok = inputToken.value.trim();
  if (!tok) {
    tokenStatus.style.display = 'block';
    tokenStatus.style.color = 'var(--vscode-errorForeground)';
    tokenStatus.textContent = '\u274c Enter a token first.';
    return;
  }
  btnValidateToken.disabled = true;
  btnValidateToken.textContent = '\u23f3';
  tokenStatus.style.display = 'block';
  tokenStatus.style.color = 'var(--vscode-descriptionForeground)';
  tokenStatus.textContent = 'Verifying\u2026';
  vscode.postMessage({ type: 'validateToken', githubToken: tok, repoUrl: inputRepo.value.trim() || undefined });
});

// ─── TOC toggle / close ─────────────────────────────────────────────────────
btnTocToggle.addEventListener('click', () => {
  var open = planToc.style.display !== 'none';
  planToc.style.display = open ? 'none' : 'block';
  btnTocToggle.style.background = open ? '' : 'var(--vscode-button-secondaryBackground)';
  if (open) { planToc.dataset.userClosed = '1'; } else { delete planToc.dataset.userClosed; }
});
document.getElementById('btn-toc-close').addEventListener('click', () => {
  planToc.style.display = 'none';
  planToc.dataset.userClosed = '1';
  btnTocToggle.style.background = '';
});

// ─── Save as .md (enhancement #2) ─────────────────────────────────────────────
btnSaveMd.addEventListener('click', () => {
  vscode.postMessage({ type: 'savePlan', plan: planMarkdown });
});

// ─── Bypass cache ─────────────────────────────────────────────────────────────
function bypassCache() {
  cacheNotice.style.display = 'none';
  lastRepoUrl = '';
  btnAnalyze.click();
}

// ─── Queue (enhancement #6) ───────────────────────────────────────────────────
inputTarget.addEventListener('input', () => {
  btnRunQueue.disabled = !inputTarget.value.trim() || !queueInput.value.trim();
});
queueInput.addEventListener('input', () => {
  btnRunQueue.disabled = !inputTarget.value.trim() || !queueInput.value.trim();
});
btnRunQueue.addEventListener('click', () => {
  const urls = queueInput.value.split('\\n').map(u => u.trim()).filter(Boolean);
  if (!urls.length) { return; }
  const target = inputTarget.value.trim();
  if (!target) { showError('Set a target stack before running the queue.'); return; }
  hideError();
  vscode.postMessage({
    type: 'addToQueue',
    queueUrls: urls,
    githubToken: inputToken.value.trim() || undefined,
    targetStack: target,
    options: getOptions(),
  });
});

// ─── History actions (enhancement #9) ─────────────────────────────────────────
btnClearHistory.addEventListener('click', () => vscode.postMessage({ type: 'clearHistory' }));

// ─── Analyze ──────────────────────────────────────────────────────────────────
btnAnalyze.addEventListener('click', () => {
  const repoUrl = inputRepo.value.trim();
  if (!repoUrl) { showError('Please enter a GitHub repository URL.'); return; }
  hideError();
  cacheNotice.style.display = 'none';
  progressSect.style.display = 'block';
  btnAnalyze.disabled = true;
  stackSection.style.display = 'none';
  btnGenerate.disabled = true;
  lastRepoUrl = repoUrl;
  vscode.postMessage({ type: 'analyze', repoUrl, githubToken: inputToken.value.trim() || undefined });
});

// ─── Browse Local Folder ────────────────────────────────────────────────────────
btnBrowseLocal.addEventListener('click', () => {
  hideError();
  vscode.postMessage({ type: 'browseLocalFolder' });
});

function analyzeLocalRepo(path, name) {
  hideError();
  cacheNotice.style.display = 'none';
  progressSect.style.display = 'block';
  progressBar.style.width = '0%';
  progressText.textContent = 'Analyzing ' + name + '…';
  stackSection.style.display = 'none';
  btnGenerate.disabled = true;
  lastRepoUrl = 'local:' + path;
  vscode.postMessage({ type: 'analyzeLocal', localPath: path });
}

function updateMultiBtn() {
  const n = localReposList.querySelectorAll('.local-repo-cb:checked').length;
  btnAnalyzeMulti.disabled = n < 1;
  btnAnalyzeMulti.textContent = n > 1
    ? '🔗 Analyze ' + n + ' repos together'
    : (n === 1 ? '🔗 Analyze 1 selected' : '🔗 Analyze selected together');
}

localSelectAll.addEventListener('change', () => {
  localReposList.querySelectorAll('.local-repo-cb').forEach((cb) => { cb.checked = localSelectAll.checked; });
  updateMultiBtn();
});

btnAnalyzeMulti.addEventListener('click', () => {
  const checked = Array.from(localReposList.querySelectorAll('.local-repo-cb:checked'));
  const paths = checked.map((c) => c.dataset.path);
  if (paths.length === 0) { return; }
  if (paths.length === 1) { analyzeLocalRepo(paths[0], checked[0].dataset.name); return; }
  hideError();
  cacheNotice.style.display = 'none';
  progressSect.style.display = 'block';
  progressBar.style.width = '0%';
  progressText.textContent = 'Analyzing ' + paths.length + ' repositories together…';
  stackSection.style.display = 'none';
  btnGenerate.disabled = true;
  lastRepoUrl = 'local-multi:' + paths.length;
  vscode.postMessage({ type: 'analyzeLocalMulti', localPaths: paths });
});

// ─── Stack Health ─────────────────────────────────────────────────────────────
btnHealth.addEventListener('click', () => {
  hideError();
  healthSection.style.display = 'block';
  healthLoading.style.display = 'block';
  healthSummary.style.display = 'none';
  healthCards.innerHTML = '';
  stackHealthMarkdown = '';
  btnHealth.disabled = true;
  vscode.postMessage({ type: 'analyzeStackHealth' });
});

// ─── Suggest Targets ──────────────────────────────────────────────────────────
btnSuggest.addEventListener('click', () => {
  hideError();
  recsSection.style.display = 'block';
  recsLoading.style.display = 'block';
  recsCards.innerHTML = '';
  stackRecsMarkdown = '';
  btnSuggest.disabled = true;
  vscode.postMessage({ type: 'recommendStacks' });
});

// ─── Generate ─────────────────────────────────────────────────────────────────
btnGenerate.addEventListener('click', () => {
  const target = inputTarget.value.trim();
  if (!target) { showError('Please enter a target stack or pick a preset.'); return; }
  hideError();
  startGeneration();
  vscode.postMessage({ type: 'generatePlan', targetStack: target, options: getOptions() });
});

btnStop.addEventListener('click', () => vscode.postMessage({ type: 'stopGeneration' }));

// ─── Architecture (LLD) actions ───────────────────────────────────────────────
function startArchGeneration() {
  archGenerating = true;
  archMode = false;
  archMarkdown = '';
  archTranscriptHTML = '';
  var oldBtn = document.getElementById('btn-arch-discussion');
  if (oldBtn) { oldBtn.remove(); }
  archEmpty.style.display = 'none';
  archContainer.style.display = 'flex';
  archGenIndicator.style.display = 'flex';
  btnArchStop.style.display = 'inline-flex';
  btnGenerateArch.disabled = true;
  btnArchRegen.disabled = true;
  btnArchSave.disabled = true;
  btnArchCopy.disabled = true;
  renderArchProgressUI('Preparing the documentation team…');
}
function stopArchGeneration() {
  archGenerating = false;
  archGenIndicator.style.display = 'none';
  btnArchStop.style.display = 'none';
  btnGenerateArch.disabled = false;
  btnArchRegen.disabled = false;
}
function requestArchitecture() {
  if (!analysisData) { showError('Please analyze a repository first.'); return; }
  hideError();
  startArchGeneration();
  vscode.postMessage({ type: 'generateArchitecture' });
}
btnGenerateArch.addEventListener('click', requestArchitecture);
btnArchRegen.addEventListener('click', requestArchitecture);
btnArchStop.addEventListener('click', () => vscode.postMessage({ type: 'stopGeneration' }));
btnArchSave.addEventListener('click', () => vscode.postMessage({ type: 'saveArchitecture' }));
btnArchCopy.addEventListener('click', () => {
  navigator.clipboard.writeText(archMarkdown).then(() => {
    btnArchCopy.textContent = 'Copied!';
    setTimeout(() => { btnArchCopy.textContent = 'Copy'; }, 1500);
  });
});

// ─── Security audit actions ───────────────────────────────────────────────────
function startSecGeneration() {
  secGenerating = true;
  secMode = false;
  secMarkdown = '';
  secTranscriptHTML = '';
  var oldBtn = document.getElementById('btn-sec-discussion');
  if (oldBtn) { oldBtn.remove(); }
  secEmpty.style.display = 'none';
  secContainer.style.display = 'flex';
  secGenIndicator.style.display = 'flex';
  secSummary.style.display = 'none';
  secSummary.innerHTML = '';
  btnSecStop.style.display = 'inline-flex';
  btnGenerateSec.disabled = true;
  btnSecRegen.disabled = true;
  btnSecSave.disabled = true;
  btnSecCopy.disabled = true;
  renderSecProgressUI('Preparing the security team…');
}
function stopSecGeneration() {
  secGenerating = false;
  secGenIndicator.style.display = 'none';
  btnSecStop.style.display = 'none';
  btnGenerateSec.disabled = false;
  btnSecRegen.disabled = false;
}
function requestSecurity() {
  if (!analysisData) { showError('Please analyze a repository first.'); return; }
  hideError();
  startSecGeneration();
  vscode.postMessage({ type: 'generateSecurity' });
}
btnGenerateSec.addEventListener('click', requestSecurity);
btnSecRegen.addEventListener('click', requestSecurity);
btnSecStop.addEventListener('click', () => vscode.postMessage({ type: 'stopGeneration' }));
btnSecSave.addEventListener('click', () => vscode.postMessage({ type: 'saveSecurity' }));
btnSecCopy.addEventListener('click', () => {
  navigator.clipboard.writeText(secMarkdown).then(() => {
    btnSecCopy.textContent = 'Copied!';
    setTimeout(() => { btnSecCopy.textContent = 'Copy'; }, 1500);
  });
});

// ─── Correction actions ───────────────────────────────────────────────────────
function startCorrGeneration() {
  corrGenerating = true;
  corrMode = false;
  corrMarkdown = '';
  corrTranscriptHTML = '';
  var oldBtn = document.getElementById('btn-corr-discussion');
  if (oldBtn) { oldBtn.remove(); }
  corrEmpty.style.display = 'none';
  corrContainer.style.display = 'flex';
  corrGenIndicator.style.display = 'flex';
  btnCorrStop.style.display = 'inline-flex';
  btnGenerateCorr.disabled = true;
  btnCorrRegen.disabled = true;
  btnCorrSave.disabled = true;
  btnCorrCopy.disabled = true;
  renderCorrProgressUI('Assembling the correction team…');
}
function stopCorrGeneration() {
  corrGenerating = false;
  corrGenIndicator.style.display = 'none';
  btnCorrStop.style.display = 'none';
  btnGenerateCorr.disabled = false;
  btnCorrRegen.disabled = false;
}
function requestCorrection(scopeRepo) {
  if (!analysisData) { showError('Please analyze a repository or folder first.'); return; }
  hideError();
  const scope = scopeRepo || '';
  corrScope.value = scope;
  corrScope2.value = scope;
  corrScopeBadge.textContent = scope ? '🔒 Scope: ' + scope : '🔒 Scope: whole project';
  corrScopeBadge.style.display = 'inline';
  startCorrGeneration();
  vscode.postMessage({ type: 'generateCorrection', scopeRepo: scope || undefined });
}
btnGenerateCorr.addEventListener('click', () => requestCorrection(corrScope.value));
btnCorrRegen.addEventListener('click', () => requestCorrection(corrScope2.value));
corrScope2.addEventListener('change', () => { corrScope.value = corrScope2.value; });
btnCorrStop.addEventListener('click', () => vscode.postMessage({ type: 'stopGeneration' }));
btnCorrApply.addEventListener('click', () => {
  if (!corrCanApply) {
    showError('Apply works only on locally-analyzed folders. Use 📁 Browse Local Folder.');
    return;
  }
  if (!corrMarkdown) { showError('Generate a correction plan first.'); return; }
  corrApplying = true;
  btnCorrApply.disabled = true;
  btnCorrApply.textContent = '⏳ Backing up & applying…';
  corrGenIndicator.style.display = 'flex';
  vscode.postMessage({ type: 'applyCorrection', scopeRepo: corrScope2.value || undefined });
});
btnCorrSave.addEventListener('click', () => vscode.postMessage({ type: 'saveCorrection' }));
btnCorrCopy.addEventListener('click', () => {
  navigator.clipboard.writeText(corrMarkdown).then(() => {
    btnCorrCopy.textContent = 'Copied!';
    setTimeout(() => { btnCorrCopy.textContent = 'Copy'; }, 1500);
  });
});

btnCopy.addEventListener('click', () => {
  navigator.clipboard.writeText(planMarkdown).then(() => {
    btnCopy.textContent = 'Copied!';
    setTimeout(() => { btnCopy.textContent = 'Copy'; }, 2000);
  });
});

function getOptions() {
  return {
    includeTestMigration: optTests.checked,
    includeCiMigration: optCi.checked,
    includeDockerMigration: optDocker.checked,
    detailLevel: detailLevel.value,
    phasedMode: true, // phased schedule is always generated
    scope: scopeSelect.value || 'full',
  };
}

// ─── File Previews ─────────────────────────────────────────────────────────────
btnPreviews.addEventListener('click', () => {
  const target = inputTarget.value.trim();
  if (!target) { showError('Set a target stack first.'); return; }
  previewsEmpty.style.display = 'none';
  previewsContainer.style.display = 'flex';
  previewsIndicator.style.display = 'flex';
  previewsMarkdown = '';
  previewsRendered.innerHTML = '';
  vscode.postMessage({ type: 'generateFilePreviews', targetStack: target });
  // Switch to previews tab
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector('[data-tab="previews"]').classList.add('active');
  document.getElementById('tab-previews').classList.add('active');
  syncGroupTriggers();
});

btnCopyPreviews.addEventListener('click', () => {
  navigator.clipboard.writeText(previewsMarkdown).then(() => {
    btnCopyPreviews.textContent = 'Copied!';
    setTimeout(() => { btnCopyPreviews.textContent = 'Copy'; }, 2000);
  });
});

// ─── Export ────────────────────────────────────────────────────────────────────
exportFormat.addEventListener('change', () => {
  const fmt = exportFormat.value;
  if (!fmt) { return; }
  exportFormat.value = '';
  if (fmt === 'exec-summary') {
    // streams to exec summary overlay
    exportMarkdown = '';
    exportOutputWrap.style.display = 'flex';
    exportTitle.textContent = '📊 Executive Summary';
    exportContent.innerHTML = '<em style="opacity:0.5">Generating…</em>';
    vscode.postMessage({ type: 'exportPlan', exportFormat: fmt });
    return;
  }
  exportMarkdown = '';
  exportOutputWrap.style.display = 'flex';
  const labels = { checklist: '✅ Checklist', 'github-issue': '🐙 GitHub Issue', confluence: '📝 Confluence' };
  exportTitle.textContent = labels[fmt] || 'Export';
  exportContent.innerHTML = '<em style="opacity:0.5">Generating…</em>';
  vscode.postMessage({ type: 'exportPlan', exportFormat: fmt });
});

btnCopyExport.addEventListener('click', () => {
  navigator.clipboard.writeText(exportMarkdown).then(() => {
    btnCopyExport.textContent = 'Copied!';
    setTimeout(() => { btnCopyExport.textContent = 'Copy'; }, 2000);
  });
});

btnCloseExport.addEventListener('click', () => { exportOutputWrap.style.display = 'none'; });

// ─── Jira Stories ──────────────────────────────────────────────────────────────
btnJiraStories.addEventListener('click', () => {
  jiraConfigModal.style.display = 'flex';
});

jiraConfigCancel.addEventListener('click', () => {
  jiraConfigModal.style.display = 'none';
});

jiraConfigGo.addEventListener('click', () => {
  const teamSize = parseInt(jiraTeamSizeInput.value, 10) || 4;
  const roles = Array.from(document.querySelectorAll('.jira-role-cb'))
    .filter(cb => cb.checked)
    .map(cb => cb.value);
  if (roles.length === 0) { roles.push('Developer'); }

  jiraConfigModal.style.display = 'none';
  jiraMarkdown = '';
  jiraCsvContent = '';
  jiraOutputWrap.style.display = 'flex';
  jiraOutput.textContent = 'Generating Jira stories...';
  btnJiraStories.disabled = true;
  btnCsvJira.disabled = true;

  const targetStack = inputTarget.value.trim() || 'modern stack';
  vscode.postMessage({
    type: 'generateJiraStories',
    targetStack,
    jiraConfig: { teamSize, sprintWeeks: 2, roles },
  });
});

btnCopyJira.addEventListener('click', () => {
  navigator.clipboard.writeText(jiraMarkdown).then(() => {
    btnCopyJira.textContent = 'Copied!';
    setTimeout(() => { btnCopyJira.textContent = 'Copy Markdown'; }, 2000);
  });
});

btnCsvJira.addEventListener('click', () => {
  if (!jiraCsvContent) { return; }
  const blob = new Blob([jiraCsvContent], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'migration-jira-stories.csv';
  a.click();
  URL.revokeObjectURL(url);
});

btnCloseJira.addEventListener('click', () => { jiraOutputWrap.style.display = 'none'; });

// ─── Download Report ──────────────────────────────────────────────────────────
const reportFormatPlaceholder = reportFormatSel.options[0]; // −0 option = placeholder label
reportFormatSel.addEventListener('change', () => {
  const fmt = reportFormatSel.value;
  if (!fmt) { return; }
  reportFormatSel.value = '';           // reset immediately so re-selection is possible
  reportFormatSel.disabled = true;
  reportFormatPlaceholder.textContent = '\u23f3 Generating...';
  // Show + scroll the progress bar into view so the user can see activity
  progressBar.style.width = '5%';
  progressText.textContent = 'Preparing detailed report via Copilot...';
  progressSect.style.display = 'block';
  progressSect.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const targetStack = inputTarget.value.trim() || 'modern stack';
  vscode.postMessage({ type: 'generateReport', targetStack, reportFormat: fmt });
});

// ─── Debug ─────────────────────────────────────────────────────────────────────
btnDebug.addEventListener('click', () => {
  const err = debugInput.value.trim();
  if (!err) { return; }
  btnDebug.disabled = true;
  btnStopDebug.style.display = 'inline-flex';
  debugEmpty.style.display = 'none';
  debugRendered.style.display = 'block';
  debugRendered.innerHTML = '';
  vscode.postMessage({ type: 'debugError', errorMessage: err });
});
btnStopDebug.addEventListener('click', () => vscode.postMessage({ type: 'stopGeneration' }));

// ─── Org Dashboard ─────────────────────────────────────────────────────────────
btnScanOrg.addEventListener('click', () => {
  const url = orgInput.value.trim();
  if (!url) { return; }
  orgProgress.style.display = 'block';
  orgProgress.textContent = 'Starting scan…';
  orgEmpty.style.display = 'none';
  vscode.postMessage({ type: 'analyzeOrg', orgUrl: url, githubToken: inputToken.value.trim() || undefined });
});

// ─── Progress Check ────────────────────────────────────────────────────────────
btnCheckProgress.addEventListener('click', () => {
  const branch = progressBranch.value.trim();
  progressEmpty.style.display = 'none';
  progressContainer.style.display = 'flex';
  progressIndicator.style.display = 'flex';
  progressRendered.innerHTML = '';
  vscode.postMessage({ type: 'checkProgress', branch });
});

// ─── Message from extension ───────────────────────────────────────────────────
window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'settingsLoaded':
      if (msg.settings.githubToken) { inputToken.value = msg.settings.githubToken; }
      if (msg.settings.copilotModel) { modelPicker.value = msg.settings.copilotModel; }
      break;

    case 'modelsLoaded': {
      // Rebuild dropdown with live Copilot-available models; preserve current selection
      const currentModel = modelPicker.value;
      modelPicker.innerHTML = msg.models.map(m =>
        \`<option value="\${m}"\${m === currentModel ? ' selected' : ''}>\${m}</option>\`
      ).join('');
      // If saved model isn't in the live list, add it so the selection stays valid
      if (!msg.models.includes(currentModel) && currentModel) {
        modelPicker.insertAdjacentHTML('afterbegin',
          \`<option value="\${currentModel}" selected>\${currentModel}</option>\`);
      }
      break;
    }

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
      renderSecurityReport(msg.analysis);
      btnGenerate.disabled = false;
      btnSuggest.disabled = false;
      btnGenerateArch.disabled = false;
      btnGenerateSec.disabled = false;
      btnGenerateCorr.disabled = false;
      corrCanApply = msg.canApply === true;
      populateCorrScope(msg.analysis);
      btnRunQueue.disabled = !inputTarget.value.trim() || !queueInput.value.trim();
      // Show preset loading spinner while AI generates options in background
      presetLoading.style.display = 'inline-flex';
      presetAiBadge.style.display = 'none';
      // Kick off AI stack enrichment automatically
      showStackLoading(true);
      vscode.postMessage({ type: 'aiDetectStack' });
      break;

    case 'cacheHit': {
      const ago = Math.round((Date.now() - msg.cachedAt) / 60000);
      cacheNotice.style.display = 'block';
      cacheNotice.querySelector('span') && (cacheNotice.querySelector('span').textContent = \`\${ago}m ago\`);
      break;
    }

    case 'localReposFound': {
      const repos = msg.localRepos || [];
      localRootLabel.textContent = msg.localRoot ? '— ' + msg.localRoot : '';
      localReposList.innerHTML = '';
      // When several repos are found, pre-select them all so "Analyze together"
      // (which is what enables per-repo scope in Correct) is the obvious default.
      const preselect = repos.length > 1;
      localSelectAll.checked = preselect;
      repos.forEach((r) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:6px';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'local-repo-cb';
        cb.checked = preselect;
        cb.dataset.path = r.path;
        cb.dataset.name = r.name;
        cb.addEventListener('change', updateMultiBtn);
        const btn = document.createElement('button');
        btn.className = 'copy-btn';
        btn.style.cssText = 'flex:1;text-align:left;display:flex;justify-content:space-between;gap:8px;align-items:center;padding:6px 8px';
        btn.title = 'Analyze ' + r.name + ' — ' + r.path;
        const nameSpan = document.createElement('span');
        nameSpan.textContent = '📦 ' + r.name;
        nameSpan.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        const markSpan = document.createElement('span');
        markSpan.textContent = r.marker;
        markSpan.style.cssText = 'opacity:0.55;font-size:10px;flex-shrink:0';
        btn.appendChild(nameSpan);
        btn.appendChild(markSpan);
        btn.addEventListener('click', () => analyzeLocalRepo(r.path, r.name));
        row.appendChild(cb);
        row.appendChild(btn);
        localReposList.appendChild(row);
      });
      localReposBox.style.display = repos.length ? 'block' : 'none';
      btnAnalyzeMulti.style.display = repos.length ? 'block' : 'none';
      updateMultiBtn();
      break;
    }

    // AI-generated presets arrived — replace the static dropdown options
    case 'presetsReady': {
      presetLoading.style.display = 'none';
      if (!msg.presets || msg.presets.length === 0) { break; }
      // Keep the placeholder option, replace everything else
      presetSelect.innerHTML = '<option value="">— AI-suggested presets —</option>';
      const effortOrder = ['Low', 'Medium', 'High', 'Very High'];
      const sorted = [...msg.presets].sort(
        (a, b) => effortOrder.indexOf(a.effort) - effortOrder.indexOf(b.effort)
      );
      const group = document.createElement('optgroup');
      group.label = '✨ Tailored for this repo';
      sorted.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.targetStack;
        opt.title = p.rationale || '';
        opt.textContent = \`[\${p.effort}] \${p.title}\`;
        group.appendChild(opt);
      });
      presetSelect.appendChild(group);
      presetAiBadge.style.display = 'inline';
      break;
    }

    // Preset generation failed — keep static options, hide spinner
    case 'presetsError':
      presetLoading.style.display = 'none';
      break;

    case 'planChunk':
      if (msg.chunk === '') {
        flushRender('plan', () => {});
        planMarkdown = '';
        clearPlanDOM();
        planOutput.textContent = '';
        showPlanContainer();
        // Reset team state — a multi-agent run announces itself via 'teamFormed'
        // (which arrives right after this clear) and switches to the team UI.
        teamMode = false;
        teamTranscriptHTML = '';
        var _oldTeamBtn = document.getElementById('btn-team-discussion');
        if (_oldTeamBtn) { _oldTeamBtn.remove(); }
        // Progress card until either the team is assembled ('teamFormed') or the
        // plan arrives. Parsing partial markdown live is fragile, so the plan is
        // rendered once at completion.
        _planProgress = { current: 0, total: 0, heading: '', phase: 'Preparing the migration plan…' };
        renderPlanProgressUI();
      } else {
        planMarkdown += msg.chunk;
        rawEmpty.style.display = 'none';
        planOutput.style.display = 'block';
        // Keep the raw-text view current (plain text is cheap + safe), but never
        // render markdown incrementally — progress is shown instead.
        planOutput.textContent = planMarkdown;
        var _isCoherence = msg.chunk.indexOf('Plan Coherence Review') !== -1;
        if (teamMode) {
          if (_isCoherence) { updateSynthesisProgress('Reviewing the plan for coherence…', 95); }
        } else if (_isCoherence) {
          _planProgress.phase = 'Reviewing plan for coherence…';
          renderPlanProgressUI();
        }
      }
      break;

    case 'teamFormed':
      setupTeamUI(msg.agents || []);
      break;

    case 'agentMessageStart':
      if (!teamMode) { setupTeamUI(teamAgents); }
      addAgentBubble(msg.agentId, msg.agentRole, msg.agentEmoji, msg.agentPhase);
      break;

    case 'agentMessageChunk':
      appendAgentChunk(msg.agentId, msg.chunk || '');
      break;

    case 'agentMessageEnd':
      finishAgentBubble(msg.agentId);
      break;

    // ── Architecture (LLD) ──
    case 'archChunk':
      if (msg.chunk === '') {
        archMarkdown = '';
        renderArchProgressUI('Preparing the documentation team…');
      } else {
        archMarkdown += msg.chunk;
        if (archMode && msg.chunk.indexOf('Glossary & Onboarding') !== -1) {
          updateArchSynthProgress('Finishing up…', 98);
        }
      }
      break;

    case 'archTeamFormed':
      setupArchUI(msg.agents || []);
      break;

    case 'archAgentMessageStart':
      if (!archMode) { setupArchUI(archAgents); }
      addArchBubble(msg.agentId, msg.agentRole, msg.agentEmoji, msg.agentPhase);
      break;

    case 'archAgentMessageChunk':
      appendArchChunk(msg.agentId, msg.chunk || '');
      break;

    case 'archAgentMessageEnd':
      finishArchBubble(msg.agentId);
      break;

    case 'archSectionProgress': {
      const aIdx = (msg.sectionIndex ?? 0) + 1;
      const aTotal = msg.sectionTotal ?? 1;
      const aPct = Math.round((aIdx / aTotal) * 95);
      const aHeading = (msg.sectionHeading ?? '').replace(/^##+ ?\d+\.?\s*/, '');
      if (archMode) {
        updateArchSynthProgress(\`Writing section \${aIdx} of \${aTotal}: \${aHeading}\`, aPct);
      } else {
        renderArchProgressUI(\`Writing section \${aIdx} of \${aTotal}: \${aHeading}\`);
      }
      break;
    }

    case 'archComplete':
      if (archMode) {
        var aSp = archRendered.querySelector('.synthesis-progress');
        if (aSp) { aSp.remove(); }
        var aRoster = archRendered.querySelector('.team-roster');
        var aDisc = document.getElementById('arch-discussion');
        archTranscriptHTML = (aRoster ? aRoster.outerHTML : '') + (aDisc ? aDisc.outerHTML : '');
      }
      renderArchFull();
      stopArchGeneration();
      if (archMode) { installArchTranscriptToggle(); archMode = false; }
      btnArchSave.disabled = !archMarkdown;
      btnArchCopy.disabled = !archMarkdown;
      if (msg.failedSections && msg.failedSections.length > 0) {
        const warn = document.createElement('div');
        warn.style.cssText = 'padding:10px 14px;margin-bottom:12px;border-radius:6px;background:var(--vscode-inputValidation-warningBackground,#5a4a00);border:1px solid var(--vscode-inputValidation-warningBorder,#b89500);font-size:13px';
        warn.textContent = '⚠️ ' + msg.failedSections.length + ' section(s) could not be generated. Try Regenerate.';
        archRendered.insertBefore(warn, archRendered.firstChild);
      }
      break;

    case 'archError':
      stopArchGeneration();
      archContainer.style.display = 'none';
      archEmpty.style.display = 'flex';
      showError(msg.message || 'Architecture generation failed.');
      break;

    case 'architectureSaved':
      btnArchSave.title = 'Saved!';
      setTimeout(() => { btnArchSave.title = 'Save as Markdown'; }, 2000);
      break;

    // ── Security audit ──
    case 'secChunk':
      if (msg.chunk === '') {
        secMarkdown = '';
        renderSecProgressUI('Preparing the security team…');
      } else {
        secMarkdown += msg.chunk;
        if (secMode && msg.chunk.indexOf('Remediation Roadmap') !== -1) {
          updateSecSynthProgress('Finishing the remediation roadmap…', 98);
        }
      }
      break;

    case 'secTeamFormed':
      setupSecUI(msg.agents || []);
      break;

    case 'secAgentMessageStart':
      if (!secMode) { setupSecUI(secAgents); }
      addSecBubble(msg.agentId, msg.agentRole, msg.agentEmoji, msg.agentPhase);
      break;

    case 'secAgentMessageChunk':
      appendSecChunk(msg.agentId, msg.chunk || '');
      break;

    case 'secAgentMessageEnd':
      finishSecBubble(msg.agentId);
      break;

    case 'secSectionProgress': {
      const sIdx = (msg.sectionIndex ?? 0) + 1;
      const sTotal = msg.sectionTotal ?? 1;
      const sPct = Math.round((sIdx / sTotal) * 95);
      const sHeading = (msg.sectionHeading ?? '').replace(/^#+ */, '');
      if (secMode) {
        updateSecSynthProgress(\`Writing: \${sHeading}\`, sPct);
      } else {
        renderSecProgressUI(\`Writing: \${sHeading}\`);
      }
      break;
    }

    case 'secComplete':
      if (secMode) {
        var sSp = secRendered.querySelector('.synthesis-progress');
        if (sSp) { sSp.remove(); }
        var sRoster = secRendered.querySelector('.team-roster');
        var sDisc = document.getElementById('sec-discussion');
        secTranscriptHTML = (sRoster ? sRoster.outerHTML : '') + (sDisc ? sDisc.outerHTML : '');
      }
      renderSecFull();
      renderSecSummary();
      stopSecGeneration();
      if (secMode) { installSecTranscriptToggle(); secMode = false; }
      btnSecSave.disabled = !secMarkdown;
      btnSecCopy.disabled = !secMarkdown;
      if (msg.failedSections && msg.failedSections.length > 0) {
        const sWarn = document.createElement('div');
        sWarn.style.cssText = 'padding:10px 14px;margin-bottom:12px;border-radius:6px;background:var(--vscode-inputValidation-warningBackground,#5a4a00);border:1px solid var(--vscode-inputValidation-warningBorder,#b89500);font-size:13px';
        sWarn.textContent = '⚠️ ' + msg.failedSections.length + ' section(s) could not be generated. Try Re-run.';
        secRendered.insertBefore(sWarn, secRendered.firstChild);
      }
      break;

    case 'secError':
      stopSecGeneration();
      secContainer.style.display = 'none';
      secEmpty.style.display = 'flex';
      showError(msg.message || 'Security audit failed.');
      break;

    case 'securitySaved':
      btnSecSave.title = 'Saved!';
      setTimeout(() => { btnSecSave.title = 'Save as Markdown'; }, 2000);
      break;

    // ── Behavior-preserving correction ──
    case 'corrChunk':
      if (msg.chunk === '') {
        corrMarkdown = '';
        renderCorrProgressUI('Assembling the correction team…');
      } else {
        corrMarkdown += msg.chunk;
        if (corrMode && msg.chunk.indexOf('Rollback & Safety Net') !== -1) {
          updateCorrSynthProgress('Finalising the safety net…', 98);
        }
      }
      break;

    case 'corrTeamFormed':
      setupCorrUI(msg.agents || []);
      break;

    case 'corrAgentMessageStart':
      if (!corrMode) { setupCorrUI(corrAgents); }
      addCorrBubble(msg.agentId, msg.agentRole, msg.agentEmoji, msg.agentPhase);
      break;

    case 'corrAgentMessageChunk':
      appendCorrChunk(msg.agentId, msg.chunk || '');
      break;

    case 'corrAgentMessageEnd':
      finishCorrBubble(msg.agentId);
      break;

    case 'corrSectionProgress': {
      const cIdx = (msg.sectionIndex ?? 0) + 1;
      const cTotal = msg.sectionTotal ?? 1;
      const cPct = Math.round((cIdx / cTotal) * 95);
      const cHeading = (msg.sectionHeading ?? '').replace(/^#+ */, '');
      if (corrMode) {
        updateCorrSynthProgress(\`Writing: \${cHeading}\`, cPct);
      } else {
        renderCorrProgressUI(\`Writing: \${cHeading}\`);
      }
      break;
    }

    case 'corrComplete':
      if (corrMode) {
        var cSp = corrRendered.querySelector('.synthesis-progress');
        if (cSp) { cSp.remove(); }
        var cRoster = corrRendered.querySelector('.team-roster');
        var cDisc = document.getElementById('corr-discussion');
        corrTranscriptHTML = (cRoster ? cRoster.outerHTML : '') + (cDisc ? cDisc.outerHTML : '');
      }
      renderCorrFull();
      stopCorrGeneration();
      if (corrMode) { installCorrTranscriptToggle(); corrMode = false; }
      btnCorrSave.disabled = !corrMarkdown;
      btnCorrCopy.disabled = !corrMarkdown;
      // Offer code-apply only for locally-analyzed folders
      btnCorrApply.style.display = corrCanApply ? 'inline-flex' : 'none';
      btnCorrApply.disabled = !corrMarkdown || !corrCanApply;
      if (msg.failedSections && msg.failedSections.length > 0) {
        const cWarn = document.createElement('div');
        cWarn.style.cssText = 'padding:10px 14px;margin-bottom:12px;border-radius:6px;background:var(--vscode-inputValidation-warningBackground,#5a4a00);border:1px solid var(--vscode-inputValidation-warningBorder,#b89500);font-size:13px';
        cWarn.textContent = '⚠️ ' + msg.failedSections.length + ' section(s) could not be generated. Try Re-run.';
        corrRendered.insertBefore(cWarn, corrRendered.firstChild);
      }
      break;

    case 'corrError':
      stopCorrGeneration();
      corrContainer.style.display = 'none';
      corrEmpty.style.display = 'flex';
      showError(msg.message || 'Correction plan failed.');
      break;

    case 'correctionSaved':
      btnCorrSave.title = 'Saved!';
      setTimeout(() => { btnCorrSave.title = 'Save as Markdown'; }, 2000);
      break;

    // ── Apply corrections to code ──
    case 'applyProgress':
      progressSect.style.display = 'block';
      progressBar.style.width = '50%';
      progressText.textContent = msg.message || 'Applying…';
      corrGenIndicator.style.display = 'flex';
      break;

    case 'applyComplete': {
      corrApplying = false;
      corrGenIndicator.style.display = 'none';
      progressSect.style.display = 'none';
      btnCorrApply.disabled = false;
      btnCorrApply.textContent = '🔧 Apply to code';
      const files = msg.appliedFiles || [];
      const backups = msg.backupPaths || [];
      const banner = document.createElement('div');
      banner.style.cssText = 'padding:12px 14px;margin-bottom:12px;border-radius:6px;background:var(--vscode-inputValidation-infoBackground,#1e3a4a);border:1px solid var(--vscode-inputValidation-infoBorder,#2196f3);font-size:13px';
      banner.innerHTML =
        '<div style="font-weight:600;margin-bottom:6px">' +
          (files.length ? '✅ Applied ' + files.length + ' file change(s)' : 'ℹ️ No files were changed (nothing safe to apply)') +
        '</div>' +
        (backups.length ? '<div style="opacity:0.85">🗂 Backup: ' + backups.map(escapeHtml).join('<br>') + '</div>' : '') +
        (files.length ? '<div style="margin-top:6px">' + files.slice(0, 50).map(escapeHtml).join('<br>') + '</div>' : '') +
        '<div style="margin-top:8px;font-weight:600">⚠️ Review the diff (git) and run your tests to confirm behavior is unchanged.</div>';
      corrRendered.insertBefore(banner, corrRendered.firstChild);
      corrRendered.scrollTop = 0;
      break;
    }

    case 'applyError':
      corrApplying = false;
      corrGenIndicator.style.display = 'none';
      progressSect.style.display = 'none';
      btnCorrApply.disabled = false;
      btnCorrApply.textContent = '🔧 Apply to code';
      showError(msg.message || 'Apply failed.');
      break;

    case 'planComplete':
      if (teamMode) {
        // Preserve the live discussion (roster + bubbles) for the toggle, then
        // drop the in-progress synthesis bar before the plan replaces it all.
        var _sp = document.getElementById('synthesis-progress');
        if (_sp) { _sp.remove(); }
        var _roster = planRendered.querySelector('.team-roster');
        var _disc = document.getElementById('team-discussion');
        teamTranscriptHTML = (_roster ? _roster.outerHTML : '') + (_disc ? _disc.outerHTML : '');
      }
      flushRender('plan', () => {
        // Full re-render with highlighting now that streaming is done.
        // Sections were frozen during streaming without highlight to avoid blocking.
        renderPlanFull();
        planOutput.textContent = planMarkdown;
      });
      if (teamMode) { installTeamTranscriptToggle(); teamMode = false; }
      stopGeneration(false);
      btnSaveMd.disabled = false;
      btnPreviews.disabled = false;
      btnJiraStories.disabled = false;
      enableChat();
      // Show a retry banner if any sections failed to generate
      if (msg.failedSections && msg.failedSections.length > 0) {
        const existingBanner = document.getElementById('section-retry-banner');
        if (existingBanner) { existingBanner.remove(); }
        const banner = document.createElement('div');
        banner.id = 'section-retry-banner';
        banner.style.cssText = [
          'display:flex', 'flex-wrap:wrap', 'gap:8px', 'align-items:center',
          'padding:10px 14px', 'margin-bottom:12px', 'border-radius:6px',
          'background:var(--vscode-inputValidation-warningBackground,#5a4a00)',
          'border:1px solid var(--vscode-inputValidation-warningBorder,#b89500)',
          'font-size:13px',
        ].join(';');
        const label = document.createElement('span');
        label.textContent = \`⚠️ \${msg.failedSections.length} section\${msg.failedSections.length === 1 ? '' : 's'} could not be generated:\`;
        banner.appendChild(label);
        msg.failedSections.forEach((heading) => {
          const btn = document.createElement('button');
          btn.textContent = \`↻ \${heading}\`;
          btn.style.cssText = 'padding:3px 10px;cursor:pointer;border-radius:4px;';
          btn.addEventListener('click', () => {
            btn.disabled = true;
            btn.textContent = \`⏳ \${heading}\`;
            vscode.postMessage({ type: 'retrySection', sectionHeading: heading });
          });
          banner.appendChild(btn);
        });
        const dismiss = document.createElement('button');
        dismiss.textContent = '✕';
        dismiss.title = 'Dismiss';
        dismiss.style.cssText = 'margin-left:auto;padding:2px 8px;cursor:pointer;opacity:0.7;border-radius:4px;';
        dismiss.addEventListener('click', () => banner.remove());
        banner.appendChild(dismiss);
        planRendered.insertBefore(banner, planRendered.firstChild);
      }
      buildToc(planMarkdown);
      break;

    case 'coherenceReady': {
      // Append coherence review as a separate DOM block — never touches planMarkdown
      // so exports, Jira, chat context and history all stay clean
      if (msg.coherenceReview) {
        const sep = document.createElement('hr');
        sep.style.cssText = 'margin:20px 0;border:none;border-top:1px solid var(--vscode-panel-border)';
        planRendered.appendChild(sep);
        const reviewDiv = document.createElement('div');
        reviewDiv.id = 'coherence-review';
        reviewDiv.innerHTML = parseMarkdown(msg.coherenceReview);
        planRendered.appendChild(reviewDiv);
        // Add a TOC entry for the coherence review section
        if (tocList) {
          const li = document.createElement('li');
          li.style.cssText = 'margin-top:6px;border-top:1px solid var(--vscode-panel-border);padding-top:6px';
          const a = document.createElement('a');
          a.textContent = '\uD83D\uDCCB Coherence Review';
          a.style.cssText = 'font-size:10px;font-style:italic;opacity:0.8';
          a.href = '#';
          a.addEventListener('click', (e) => {
            e.preventDefault();
            reviewDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
          });
          li.appendChild(a);
          tocList.appendChild(li);
        }
      }
      break;
    }

    case 'planDiff': {
      // Show an inline diff badge in the plan header after any patch or retry
      const stats = msg.diffStats;
      if (!stats) { break; }
      const existing = document.getElementById('plan-diff-badge');
      if (existing) { existing.remove(); }
      const badge = document.createElement('div');
      badge.id = 'plan-diff-badge';
      badge.style.cssText = [
        'display:inline-flex', 'gap:6px', 'align-items:center',
        'padding:3px 10px', 'border-radius:12px', 'font-size:11px',
        'background:var(--vscode-diffEditor-insertedLineBackground,rgba(0,180,0,0.07))',
        'border:1px solid var(--vscode-diffEditor-insertedTextBorder,rgba(0,180,0,0.3))',
        'margin-left:8px', 'vertical-align:middle',
      ].join(';');
      const addSpan = document.createElement('span');
      addSpan.style.color = 'var(--vscode-gitDecoration-addedResourceForeground,#81c784)';
      addSpan.textContent = '+' + stats.added;
      const remSpan = document.createElement('span');
      remSpan.style.color = 'var(--vscode-gitDecoration-deletedResourceForeground,#e57373)';
      remSpan.textContent = '-' + stats.removed;
      badge.appendChild(addSpan);
      badge.appendChild(remSpan);
      if (stats.sections && stats.sections.length > 0) {
        const secSpan = document.createElement('span');
        secSpan.style.cssText = 'opacity:0.7;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        secSpan.title = stats.sections.join(', ');
        secSpan.textContent = stats.sections.length === 1
          ? stats.sections[0].slice(0, 30)
          : stats.sections.length + ' sections changed';
        badge.appendChild(secSpan);
      }
      const closeBtn = document.createElement('button');
      closeBtn.textContent = '\u2715';
      closeBtn.style.cssText = 'background:none;border:none;cursor:pointer;opacity:0.5;font-size:10px;padding:0 2px';
      closeBtn.addEventListener('click', () => badge.remove());
      badge.appendChild(closeBtn);
      const planHeader = document.querySelector('.plan-header');
      if (planHeader) { planHeader.appendChild(badge); }
      buildToc(planMarkdown);
      break;
    }

    case 'sectionProgress': {
      // Drive the in-plan progress card — the formatted plan is rendered once at
      // planComplete, so this is the only live feedback while the plan streams.
      const idx   = (msg.sectionIndex ?? 0) + 1;
      const total = msg.sectionTotal ?? 1;
      const pct   = Math.round((idx / total) * 90);
      progressBar.style.width = pct + '%';
      const shortHeading = (msg.sectionHeading ?? '').replace(/^##+ ?\d+\.?\s*/, '');
      progressText.textContent = \`Generating section \${idx} of \${total}: \${shortHeading}\`;
      if (teamMode) {
        updateSynthesisProgress(\`Writing section \${idx} of \${total}: \${shortHeading}\`, pct);
      } else {
        _planProgress.current = idx;
        _planProgress.total = total;
        _planProgress.heading = shortHeading;
        _planProgress.phase = 'Generating migration plan…';
        renderPlanProgressUI();
      }
      break;
    }

    case 'planSaved':
      btnSaveMd.title = 'Saved!';
      setTimeout(() => { btnSaveMd.title = 'Save plan as .md'; }, 2000);
      break;

    case 'stopped':
      stopGeneration(true);
      if (archGenerating) {
        stopArchGeneration();
        if (!archMarkdown) {
          archContainer.style.display = 'none';
          archEmpty.style.display = 'flex';
        } else {
          renderArchFull();
        }
        archMode = false;
      }
      if (secGenerating) {
        stopSecGeneration();
        if (!secMarkdown) {
          secContainer.style.display = 'none';
          secEmpty.style.display = 'flex';
        } else {
          renderSecFull();
          renderSecSummary();
        }
        secMode = false;
      }
      if (corrGenerating) {
        stopCorrGeneration();
        if (!corrMarkdown) {
          corrContainer.style.display = 'none';
          corrEmpty.style.display = 'flex';
        } else {
          renderCorrFull();
        }
        corrMode = false;
      }
      break;

    case 'error':
      progressSect.style.display = 'none';
      btnAnalyze.disabled = false;
      stopGeneration(true);
      showError(msg.message);
      break;

    // Token validation (enhancement #12)
    case 'tokenValidation':
      tokenStatus.style.display = 'block';
      if (msg.isValid) {
        tokenStatus.style.color = 'var(--vscode-testing-iconPassed, #4caf50)';
        tokenStatus.textContent = \`✅ Valid — logged in as @\${msg.username}\`;
      } else {
        tokenStatus.style.color = 'var(--vscode-errorForeground)';
        tokenStatus.textContent = \`❌ \${msg.message || 'Invalid token'}\`;
      }
      break;

    // History (enhancement #9)
    case 'historyLoaded':
      renderHistory(msg.entries || []);
      break;

    // Queue progress (enhancement #6)
    case 'queueProgress':
      queueStatus.style.display = 'block';
      queueStatus.textContent = \`Processing \${msg.queueIndex}/\${msg.queueTotal}: \${msg.queueRepo}\`;
      break;

    // File previews (enhancement #1)
    case 'previewChunk':
      if (msg.chunk === '') { flushRender('previews', () => {}); previewsMarkdown = ''; previewsRendered.innerHTML = ''; }
      else {
        previewsMarkdown += msg.chunk;
        scheduleRender('previews', () => {
          previewsRendered.innerHTML = parseMarkdown(previewsMarkdown);
          previewsRendered.scrollTop = previewsRendered.scrollHeight;
        });
      }
      break;
    case 'previewComplete':
      flushRender('previews', () => {
        previewsRendered.innerHTML = parseMarkdown(previewsMarkdown);
      });
      previewsIndicator.style.display = 'none';
      break;

    // Debug (enhancement #3)
    case 'debugChunk':
      if (msg.chunk === '') { flushRender('debug', () => {}); debugRendered.innerHTML = ''; debugRendered.dataset.md = ''; }
      else {
        debugRendered.dataset.md = (debugRendered.dataset.md || '') + msg.chunk;
        scheduleRender('debug', () => { debugRendered.innerHTML = parseMarkdown(debugRendered.dataset.md); });
      }
      break;
    case 'debugComplete':
      flushRender('debug', () => {
        debugRendered.innerHTML = parseMarkdown(debugRendered.dataset.md || '');
      });
      btnDebug.disabled = false;
      btnStopDebug.style.display = 'none';
      break;

    // Export (enhancement #4)
    case 'exportReady':
      exportMarkdown = msg.exportContent || '';
      exportContent.innerHTML = exportMarkdown
        ? parseMarkdown(exportMarkdown)
        : '<em style="opacity:0.5">Generating…</em>';
      break;

    // Exec Summary (enhancement #5)
    case 'execSummaryChunk':
      if (msg.chunk === '') { exportMarkdown = ''; exportContent.innerHTML = ''; }
      else { exportMarkdown += msg.chunk; scheduleRender('export', function() { exportContent.innerHTML = parseMarkdown(exportMarkdown); }); }
      break;
    case 'execSummaryComplete':
      break;

    // Org dashboard (enhancement #7)
    case 'orgDashboard':
      orgProgress.style.display = 'none';
      renderOrgDashboard(msg.dashboard);
      break;

    // Progress check (enhancement #8)
    case 'progressChunk':
      if (msg.chunk === '') { flushRender('progress', () => {}); progressRendered.innerHTML = ''; progressRendered.dataset.md = ''; }
      else {
        progressRendered.dataset.md = (progressRendered.dataset.md || '') + msg.chunk;
        scheduleRender('progress', () => { progressRendered.innerHTML = parseMarkdown(progressRendered.dataset.md); });
      }
      break;
    case 'progressComplete':
      flushRender('progress', () => {
        progressRendered.innerHTML = parseMarkdown(progressRendered.dataset.md || '');
      });
      progressIndicator.style.display = 'none';
      break;

    // AI stack detection
    case 'aiStackDetected':
      showStackLoading(false);
      if (msg.aiStack) { renderAIStack(msg.aiStack, analysisData); }
      break;

    // Stack health analysis
    case 'stackHealthChunk':
      if (msg.chunk === '') { stackHealthMarkdown = ''; }
      else { stackHealthMarkdown += msg.chunk; }
      break;
    case 'stackHealthComplete':
      healthLoading.style.display = 'none';
      btnHealth.disabled = false;
      renderHealthCards(stackHealthMarkdown);
      break;

    // Stack recommendations
    case 'stackRecsChunk':
      if (msg.chunk === '') { stackRecsMarkdown = ''; }
      else { stackRecsMarkdown += msg.chunk; }
      break;
    case 'stackRecsComplete':
      recsLoading.style.display = 'none';
      btnSuggest.disabled = false;
      renderRecCards(stackRecsMarkdown);
      break;

    // Report generation
    case 'reportReady':
      reportFormatSel.value = '';
      reportFormatSel.disabled = false;
      reportFormatPlaceholder.textContent = '\u2b07 Report...';
      progressSect.style.display = 'none';
      showInfoMsg('Report saved: ' + msg.message);
      break;
    case 'reportError':
      reportFormatSel.value = '';
      reportFormatSel.disabled = false;
      reportFormatPlaceholder.textContent = '\u2b07 Report...';
      progressSect.style.display = 'none';
      showError('Report error: ' + msg.message);
      break;

    // Jira stories generation
    case 'jiraStoriesChunk':
      if (msg.chunk) {
        jiraMarkdown += msg.chunk;
        scheduleRender('jira', () => {
          jiraOutput.innerHTML = parseMarkdown(jiraMarkdown);
          jiraOutput.scrollTop = jiraOutput.scrollHeight;
        });
      }
      break;
    case 'jiraStoriesComplete':
      flushRender('jira', () => {
        jiraOutput.innerHTML = parseMarkdown(jiraMarkdown);
      });
      btnJiraStories.disabled = false;
      btnCsvJira.disabled = false;
      break;
    case 'jiraStoriesCsv':
      jiraCsvContent = msg.csvContent || '';
      break;

    // Chat
    case 'chatChunk':
      if (msg.chunk === '') {
        // New assistant turn starting — pending bubble already added by startChatReply()
        flushRender('chat', () => {});
        chatReplyBuf = '';
      } else {
        chatReplyBuf += msg.chunk;
        scheduleRender('chat', () => {
          const bubble = document.getElementById('chat-pending-bubble');
          if (bubble) {
            bubble.innerHTML = parseMarkdown(chatReplyBuf) + \`<span class="cursor"></span>\`;
            chatThread.scrollTop = chatThread.scrollHeight;
          }
        });
      }
      break;

    case 'chatComplete': {
      flushRender('chat', () => {
        const pendingBubble = document.getElementById('chat-pending-bubble');
        if (pendingBubble) { pendingBubble.innerHTML = parseMarkdown(chatReplyBuf); }
      });
      const bubble = document.getElementById('chat-pending-bubble');
      if (bubble) { bubble.removeAttribute('id'); }
      const wrap = document.getElementById('chat-pending-wrap');
      if (wrap) { wrap.removeAttribute('id'); }
      stopChatReply();
      chatThread.scrollTop = chatThread.scrollHeight;
      break;
    }

    case 'chatCleared':
      // Already cleared by button handler
      break;

    // Stack component swap detected in chat
    case 'stackChangeDetected': {
      const intent = msg.stackChangeIntent;
      if (!intent) { break; }
      stackChangeTitle.textContent =
        \`Apply stack change: \${intent.fromComponent} → \${intent.toComponent}?\`;
      if (intent.reason) {
        stackChangeReason.textContent = \`Reason: \${intent.reason}\`;
        stackChangeReason.style.display = 'block';
      } else {
        stackChangeReason.style.display = 'none';
      }
      // Show extra guidance and "Regenerate full plan" button for major changes
      if (intent.scope === 'major') {
        btnRegeneratePlan.style.display = 'inline-flex';
        bannerScopeNote.textContent =
          '⚠️ This is a primary framework change. Regenerating the full plan produces a more coherent result; updating only affected sections is faster but may leave inconsistencies.';
        bannerScopeNote.style.display = 'block';
        btnApplyStackChange.textContent = 'Update affected sections';
      } else {
        btnRegeneratePlan.style.display = 'none';
        bannerScopeNote.style.display = 'none';
        btnApplyStackChange.textContent = 'Update affected sections';
      }
      stackChangeBanner.style.display = 'flex';
      // Auto-scroll the chat tab so the banner is visible
      stackChangeBanner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      break;
    }

    // Plan is being rewritten section-by-section
    case 'planPatchChunk':
      if (msg.chunk === '') {
        // Empty chunk = patch starting.
        flushRender('plan', () => {});
        planMarkdown = '';
        clearPlanDOM();
        // Show a progress card instead of live-rendering partial markdown; the
        // patched plan is rendered once at planPatchComplete.
        _planProgress = { current: 0, total: 0, heading: '', phase: 'Updating migration plan…' };
        renderPlanProgressUI();
      } else {
        planMarkdown += msg.chunk;
        planOutput.textContent = planMarkdown;
      }
      break;

    // Plan patch complete — update status and switch to plan tab
    case 'planPatchComplete': {
      flushRender('plan', () => {});
      planPatchIndicator.style.display = 'none';
      if (msg.patchedPlan) {
        planMarkdown = msg.patchedPlan;
        renderPlanFull();
        planOutput.textContent = planMarkdown;
      } else {
        renderPlanFull();
        planOutput.textContent = planMarkdown;
      }
      // Append a confirmation bubble so the user knows the plan was updated
      const note = document.createElement('div');
      note.className = 'chat-msg-wrap assistant';
      const noteBubble = document.createElement('div');
      noteBubble.className = 'chat-bubble assistant';
      noteBubble.style.background = 'var(--vscode-inputValidation-infoBackground, #1e3a4a)';
      noteBubble.style.borderLeft = '3px solid var(--vscode-inputValidation-infoBorder, #2196f3)';
      noteBubble.textContent = '✅ Migration plan has been updated. Switch to the Plan tab to review the changes.';
      note.appendChild(noteBubble);
      chatThread.appendChild(note);
      chatThread.scrollTop = chatThread.scrollHeight;
      buildToc(planMarkdown);
      break;
    }
  }
});

// ─── UI Helpers ───────────────────────────────────────────────────────────────

// ─── Health Cards ─────────────────────────────────────────────────────────────

function renderHealthCards(markdown) {
  healthCards.innerHTML = '';

  // Extract and show the summary line
  const summaryMatch = markdown.match(/\*\*Health Score:.*?\*\*[^\n]*/);
  if (summaryMatch) {
    healthSummary.style.display = 'block';
    healthSummary.innerHTML = parseMarkdown(summaryMatch[0]);
  }

  // Split into issue sections by "## " headings
  const sections = markdown.split(/(?=## )/g).filter(s => s.startsWith('## '));

  sections.forEach(section => {
    const titleMatch = section.match(/## (.+)/);
    if (!titleMatch) { return; }
    const title = titleMatch[1].trim();

    const impactMatch = section.match(/\*\*Impact:\*\*\s*(High|Medium|Low)/i);
    const impact = impactMatch ? impactMatch[1].toLowerCase() : 'medium';

    const problemMatch = section.match(/\*\*Problem:\*\*\s*([^\n]+)/i);
    const problem = problemMatch ? problemMatch[1].trim() : '';

    const fixMatch = section.match(/\*\*Fix:\*\*\s*([^\n]+)/i);
    const fix = fixMatch ? fixMatch[1].trim() : '';

    const card = document.createElement('div');
    card.className = \`health-card impact-\${impact}\`;
    card.innerHTML = \`
      <div class="health-card-title">
        \${escapeHtml(title)}<span class="health-impact">\${escapeHtml(impact.toUpperCase())}</span>
      </div>
      \${problem ? \`<div class="health-problem">\${escapeHtml(problem)}</div>\` : ''}
      \${fix ? \`<div class="health-fix">\${escapeHtml(fix)}</div>\` : ''}
    \`;
    healthCards.appendChild(card);
  });

  if (healthCards.children.length === 0) {
    healthCards.innerHTML = \`<div class="rec-body">\${parseMarkdown(markdown)}</div>\`;
  }
}

// ─── Recommendation Cards ──────────────────────────────────────────────────────

function renderRecCards(markdown) {
  recsCards.innerHTML = '';
  // Split by "## Option" headings
  const sections = markdown.split(/(?=## Option \d+:)/g).filter(s => s.trim());

  sections.forEach(section => {
    // Extract title
    const titleMatch = section.match(/## Option \d+:\s*(.+)/);
    if (!titleMatch) { return; }
    const title = titleMatch[1].trim();

    // Extract effort
    const effortMatch = section.match(/\*\*Effort:\*\*\s*(.+)/i);
    const effort = effortMatch ? effortMatch[1].trim() : '';

    // Extract best for
    const bestForMatch = section.match(/\*\*Best for:\*\*\s*(.+)/i);
    const bestFor = bestForMatch ? bestForMatch[1].trim() : '';

    // Extract [TARGET]: line
    const targetMatch = section.match(/\[TARGET\]:\s*(.+)/i);
    const target = targetMatch ? targetMatch[1].trim() : '';

    // Extract pros/cons block (between Best for and [TARGET])
    let body = section
      .replace(/## Option \d+:.+/g, '')
      .replace(/\*\*Effort:\*\*.*\n?/g, '')
      .replace(/\*\*Best for:\*\*.*\n?/g, '')
      .replace(/\[TARGET\]:.*/g, '')
      .trim();

    // Build effort badge class
    const effortLower = effort.toLowerCase().replace(/\s+/g, '-');
    const effortClass = ['low','medium','high','very-high'].includes(effortLower)
      ? \`effort-\${effortLower}\`
      : 'effort-medium';

    const card = document.createElement('div');
    card.className = 'rec-card';
    card.innerHTML = \`
      <div class="rec-card-header">
        <span class="rec-title">\${escapeHtml(title)}</span>
        \${effort ? \`<span class="effort-badge \${effortClass}">\${escapeHtml(effort)} effort</span>\` : ''}
      </div>
      \${bestFor ? \`<p class="rec-bestfor">\${escapeHtml(bestFor)}</p>\` : ''}
      <div class="rec-body">\${parseMarkdown(body)}</div>
      \${target ? \`<button class="btn btn-primary rec-use-btn" data-target="\${escapeHtml(target)}">→ Use This Target</button>\` : ''}
    \`;

    if (target) {
      card.querySelector('.rec-use-btn').addEventListener('click', () => {
        inputTarget.value = target;
        inputTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
        inputTarget.focus();
      });
    }

    recsCards.appendChild(card);
  });

  if (recsCards.children.length === 0) {
    // Fallback: render raw markdown if parsing failed
    recsCards.innerHTML = \`<div class="rec-body">\${parseMarkdown(markdown)}</div>\`;
  }
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showInfoMsg(text) {
  errorBox.className = 'msg-info';
  errorBox.textContent = text;
  errorBox.style.display = 'block';
  setTimeout(() => { errorBox.style.display = 'none'; }, 6000);
}

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
  // Cancel any pending scheduleRender timer — otherwise it can fire after the
  // final renderPlanFull below and overwrite the last section with a streaming cursor.
  flushRender('plan', function() {});
  if (cancelled && planMarkdown) {
    planMarkdown += '\\n\\n---\\n*Generation stopped.*';
    renderPlanFull();
  }
}

function showPlanContainer() {
  planEmpty.style.display = 'none';
  planContainer.style.display = 'flex';
}

// ─── Security Report (enhancement #11) ────────────────────────────────────────
function renderSecurityReport(analysis) {
  const r = analysis.redactionSummary;
  const lines = [];

  if (r.skippedFiles.length > 0) {
    lines.push('<h4 style="margin:8px 0 4px">🚫 Blocked Files (never fetched)</h4>');
    lines.push('<ul>' + r.skippedFiles.map(f => \`<li style="color:var(--vscode-errorForeground)">\${escapeHtml(f)}</li>\`).join('') + '</ul>');
  } else {
    lines.push('<p style="color:var(--vscode-testing-iconPassed,#4caf50)">✅ No blocked files matched.</p>');
  }

  if (r.filesWithSecrets.length > 0) {
    lines.push('<h4 style="margin:12px 0 4px">🔐 Secrets Redacted</h4>');
    lines.push(\`<p>Total redactions: <strong>\${r.totalRedactions}</strong></p>\`);
    lines.push('<ul>' + r.filesWithSecrets.map(f => \`<li>\${escapeHtml(f)}</li>\`).join('') + '</ul>');
  } else {
    lines.push('<p style="color:var(--vscode-testing-iconPassed,#4caf50);margin-top:12px">✅ No secrets detected in fetched files.</p>');
  }

  lines.push('<h4 style="margin:12px 0 4px">📁 Files Analyzed</h4>');
  const fileRows = analysis.keyFiles.map(f =>
    \`<tr><td>\${escapeHtml(f.path)}</td><td>\${escapeHtml(f.type)}</td><td>\${f.redactedCount > 0 ? \`<span style="color:var(--vscode-errorForeground)">\${f.redactedCount} redacted</span>\` : '✅ clean'}</td></tr>\`
  ).join('');
  lines.push(\`<table style="width:100%;border-collapse:collapse;font-size:11px">
    <thead><tr><th style="text-align:left;padding:4px;border-bottom:1px solid var(--vscode-panel-border)">File</th><th style="padding:4px;border-bottom:1px solid var(--vscode-panel-border)">Type</th><th style="padding:4px;border-bottom:1px solid var(--vscode-panel-border)">Status</th></tr></thead>
    <tbody>\${fileRows}</tbody></table>\`);

  securityContent.innerHTML = lines.join('');
  securityEmpty.style.display = 'none';
  securityReport.style.display = 'block';
}

// ─── History Render (enhancement #9) ──────────────────────────────────────────
function renderHistory(entries) {
  if (!entries || entries.length === 0) {
    historyList.innerHTML = '<div style="font-size:11px;color:var(--vscode-descriptionForeground)">No history yet.</div>';
    return;
  }
  historyList.innerHTML = entries.map(e => {
    const ago = formatAgo(e.timestamp);
    return \`<div style="display:flex;flex-direction:column;gap:2px;padding:6px 8px;background:var(--vscode-editor-inactiveSelectionBackground);border-radius:4px;font-size:11px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <strong style="word-break:break-all">\${escapeHtml(e.repo)}</strong>
        <button onclick="removeHistory('\${e.id}')" style="background:none;border:none;color:var(--vscode-descriptionForeground);cursor:pointer;font-size:11px;padding:0 2px" title="Remove">✕</button>
      </div>
      <div style="color:var(--vscode-descriptionForeground)">\${escapeHtml(e.targetStack)}</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px">
        <span style="opacity:0.6">\${ago}</span>
        <button onclick="loadHistory('\${e.id}')" class="copy-btn" style="font-size:10px">Load</button>
      </div>
    </div>\`;
  }).join('');
}

function loadHistory(id) {
  vscode.postMessage({ type: 'loadFromHistory', historyId: id });
}
function removeHistory(id) {
  vscode.postMessage({ type: 'removeFromHistory', historyId: id });
}
function formatAgo(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) { return 'just now'; }
  if (m < 60) { return \`\${m}m ago\`; }
  const h = Math.floor(m / 60);
  if (h < 24) { return \`\${h}h ago\`; }
  return \`\${Math.floor(h / 24)}d ago\`;
}

// ─── Org Dashboard Render (enhancement #7) ────────────────────────────────────
function renderOrgDashboard(dashboard) {
  orgSummary.textContent = \`\${dashboard.org} — \${dashboard.repos.length} of \${dashboard.totalRepos} repos shown\`;
  const complexityColor = { Low: '#4caf50', Medium: '#ff9800', High: '#f44336', Unknown: '#9e9e9e' };
  orgTbody.innerHTML = dashboard.repos.map(r => \`
    <tr style="border-bottom:1px solid var(--vscode-panel-border)">
      <td style="padding:6px 8px">
        <strong>\${escapeHtml(r.name)}</strong>
        \${r.description ? \`<br><span style="font-size:10px;opacity:0.7">\${escapeHtml(r.description.slice(0,60))}</span>\` : ''}
      </td>
      <td style="padding:6px 8px;text-align:center">\${escapeHtml(r.language)}</td>
      <td style="padding:6px 8px;text-align:center">\${escapeHtml(r.detectedStack || '?')}</td>
      <td style="padding:6px 8px;text-align:center">⭐ \${r.stars}</td>
      <td style="padding:6px 8px;text-align:center">
        <span style="color:\${complexityColor[r.complexity] || '#9e9e9e'};font-weight:600">\${r.complexity}</span>
      </td>
      <td style="padding:6px 8px;text-align:center">
        <button class="copy-btn" onclick="analyzeOrgRepo('\${escapeHtml(r.fullName)}','\${escapeHtml(dashboard.hostname)}')">Analyze</button>
      </td>
    </tr>\`).join('');
  orgEmpty.style.display = 'none';
  orgTableWrap.style.display = 'block';
}

function analyzeOrgRepo(fullName, hostname) {
  const url = \`https://\${hostname}/\${fullName}\`;
  inputRepo.value = url;
  // Switch to main sidebar and trigger analysis
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector('[data-tab="plan"]').classList.add('active');
  document.getElementById('tab-plan').classList.add('active');
  syncGroupTriggers();
  btnAnalyze.click();
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

function showStackLoading(show) {
  stackAiLoading.style.display = show ? 'block' : 'none';
}

function renderAIStack(ai, analysis) {
  const info = analysis?.repoInfo || {};
  stackCard.innerHTML = [
    info.owner ? row('Repo', \`\${info.owner}/\${info.repo}\`) : '',
    row('Language',    ai.primaryLanguage),
    row('Runtime',     ai.currentVersion || ai.runtime),
    row('Framework',   ai.framework),
    row('Build Tool',  ai.buildTool),
    row('Pkg Manager', ai.packageManager),
    row('CI/CD',       ai.ciSystem || 'None'),
    row('Docker',      ai.containerized ? '✅ Yes' : '❌ No'),
    ai.databases?.length        ? row('Databases', ai.databases.join(', '))         : '',
    ai.testingFrameworks?.length ? row('Tests',    ai.testingFrameworks.join(', '))  : '',
    info.totalFiles ? row('Files', info.totalFiles.toLocaleString()) : '',
    info.stars !== undefined ? row('Stars', '⭐ ' + info.stars.toLocaleString()) : '',
    ai.insights ? \`<div class="stack-row" style="flex-direction:column;gap:2px">
      <span class="stack-key" style="margin-bottom:2px">AI Insights</span>
      <span class="stack-val" style="text-align:left;font-weight:400;opacity:0.85;font-size:10.5px">\${escapeHtml(ai.insights)}</span>
    </div>\` : '',
  ].filter(Boolean).join('');
  // Mark card as AI-enriched with a subtle badge
  stackCard.style.position = 'relative';
  const badge = document.createElement('div');
  badge.style.cssText = 'position:absolute;top:6px;right:8px;font-size:9px;font-weight:700;padding:1px 5px;border-radius:6px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);opacity:0.8';
  badge.textContent = '✨ AI';
  stackCard.appendChild(badge);
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

// ─── Syntax Highlighter ────────────────────────────────────────────────────────
function highlight(code, lang) {
  function he(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  // Skip syntax highlighting for large blocks — the char-by-char loop would
  // block the browser thread and freeze rendering while the plan is streaming.
  if (code.length > 4000) { return he(code); }
  var KW = {
    python:     'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield',
    javascript: 'async await break case catch class const continue default delete do else export extends finally for from function if import in instanceof let new of return static super switch throw try typeof var void while yield true false null undefined this',
    typescript: 'abstract any as async await break case catch class const continue declare default delete do else enum export extends finally for from function if implements import in instanceof interface is keyof let namespace never new null of override private protected public readonly return satisfies static super switch this throw try type typeof undefined var void while yield true false',
    java:       'abstract assert boolean break byte case catch char class continue default do double else enum extends final finally float for if implements import instanceof int interface long native new null package private protected public return short static super switch synchronized this throw throws transient try var void volatile while true false',
    csharp:     'abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while',
    go:         'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil iota',
    ruby:       'alias and begin break case class def do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield',
    php:        'abstract and array as break case catch class clone const continue declare default do echo else elseif enum extends final finally fn for foreach function global if implements instanceof interface match namespace new or private protected public readonly require return static switch throw trait try use var while yield true false null',
    sql:        'select from where join inner left right outer on as and or not in is null like between order by group having insert into values update set delete create table drop alter add column primary key foreign references index unique default view case when then else end distinct limit offset union all exists true false',
    bash:       'if then else elif fi for while do done case esac function return break continue exit export local readonly source unset in declare let eval',
  };
  var ALIAS = {js:'javascript',ts:'typescript',cs:'csharp',sh:'bash',shell:'bash',py:'python',rb:'ruby'};
  var ln = (ALIAS[lang] || lang || '').toLowerCase();
  var kws = {}; (KW[ln] || '').split(' ').forEach(function(k) { if (k) kws[k] = 1; });
  var lc = ({python:'#',ruby:'#',bash:'#',sql:'--',javascript:'//',typescript:'//',java:'//',csharp:'//',go:'//',php:'//'})[ln] || '//';
  var hasBC = ['javascript','typescript','java','csharp','go','php'].indexOf(ln) >= 0;
  var r = '', i = 0, n = code.length, j, w;
  while (i < n) {
    var ch = code[i];
    // Block comment /* ... */
    if (hasBC && ch === '/' && code[i+1] === '*') {
      j = code.indexOf('*/', i+2); j = j < 0 ? n : j+2;
      r += '<span class="tok-cmt">' + he(code.slice(i,j)) + '</span>'; i = j; continue;
    }
    // Line comment
    if (code.substr(i, lc.length) === lc) {
      j = i; while (j < n && code.charCodeAt(j) !== 10) j++;
      r += '<span class="tok-cmt">' + he(code.slice(i,j)) + '</span>'; i = j; continue;
    }
    // Triple-quoted string (Python/JS)
    if ((ch === '"' || ch === "'") && code[i+1] === ch && code[i+2] === ch) {
      j = i+3;
      while (j < n) { if (code.charCodeAt(j) === 92) { j+=2; continue; } if (code[j]===ch && code[j+1]===ch && code[j+2]===ch) { j+=3; break; } j++; }
      r += '<span class="tok-str">' + he(code.slice(i,j)) + '</span>'; i = j; continue;
    }
    // Single / double quoted string
    if (ch === '"' || ch === "'") {
      j = i+1;
      while (j < n) { if (code.charCodeAt(j) === 92) { j+=2; continue; } if (code[j] === ch || code.charCodeAt(j) === 10) { j++; break; } j++; }
      r += '<span class="tok-str">' + he(code.slice(i,j)) + '</span>'; i = j; continue;
    }
    // Template literal (backtick = char code 96)
    if (code.charCodeAt(i) === 96) {
      j = i+1;
      while (j < n) { if (code.charCodeAt(j) === 92) { j+=2; continue; } if (code.charCodeAt(j) === 96) { j++; break; } j++; }
      r += '<span class="tok-str">' + he(code.slice(i,j)) + '</span>'; i = j; continue;
    }
    // Number
    if (ch >= '0' && ch <= '9' && (i === 0 || !/[\w$]/.test(code[i-1]))) {
      j = i; while (j < n && /[\w.]/.test(code[j])) j++;
      r += '<span class="tok-num">' + he(code.slice(i,j)) + '</span>'; i = j; continue;
    }
    // Decorator @name
    if (ch === '@') {
      j = i+1; while (j < n && /\w/.test(code[j])) j++;
      r += '<span class="tok-dec">' + he(code.slice(i,j)) + '</span>'; i = j; continue;
    }
    // Identifier / keyword
    if (/[a-zA-Z_$]/.test(ch)) {
      j = i; while (j < n && /[\w$]/.test(code[j])) j++;
      w = code.slice(i,j);
      r += kws[w] ? '<span class="tok-kw">' + he(w) + '</span>' : he(w); i = j; continue;
    }
    r += he(ch); i++;
  }
  return r;
}

function copyCode(btn) {
  var pre = btn.parentElement && btn.parentElement.nextElementSibling;
  if (!pre) { return; }
  var text = pre.textContent || '';
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(function() {
      btn.textContent = '\u2713 Copied';
      var b = btn;
      setTimeout(function() { b.textContent = 'Copy'; }, 1500);
    });
  }
}

// \u2500\u2500\u2500 Mermaid diagram rendering (lazy-loaded, fully local \u2014 no data leaves) \u2500\u2500\u2500\u2500\u2500
function _getMermaid() {
  var ns = window.__esbuild_esm_mermaid_nm && window.__esbuild_esm_mermaid_nm.mermaid;
  if (!ns) { return null; }
  return ns.default || ns;
}
function toggleMermaidSrc(btn) {
  var wrap = btn.closest('.mermaid-wrap');
  if (!wrap) { return; }
  var pre = wrap.querySelector('.mermaid-src');
  if (pre) { pre.style.display = pre.style.display === 'none' ? 'block' : 'none'; }
}
// Load the bundled mermaid script on first use, then invoke cb().
var _mermaidState = 0; // 0=unloaded, 1=loading, 2=ready, 3=failed
var _mermaidQueue = [];
function ensureMermaid(cb) {
  if (_mermaidState === 2) { cb(true); return; }
  if (_mermaidState === 3) { cb(false); return; }
  _mermaidQueue.push(cb);
  if (_mermaidState === 1) { return; }
  if (!MERMAID_URI) { _mermaidState = 3; _mermaidQueue.forEach(function(f){ f(false); }); _mermaidQueue = []; return; }
  _mermaidState = 1;
  var s = document.createElement('script');
  s.src = MERMAID_URI;
  s.onload = function() {
    var m = _getMermaid();
    if (m) {
      var dark = !window.matchMedia || window.matchMedia('(prefers-color-scheme: light)').matches !== true;
      try { m.initialize({ startOnLoad: false, securityLevel: 'loose', theme: dark ? 'dark' : 'default' }); } catch (e) {}
      _mermaidState = 2;
    } else { _mermaidState = 3; }
    _mermaidQueue.forEach(function(f){ f(_mermaidState === 2); }); _mermaidQueue = [];
  };
  s.onerror = function() { _mermaidState = 3; _mermaidQueue.forEach(function(f){ f(false); }); _mermaidQueue = []; };
  document.head.appendChild(s);
}
// Render every un-rendered mermaid block inside a container.
function renderMermaidIn(container) {
  if (!container) { return; }
  var blocks = container.querySelectorAll('.mermaid-wrap');
  if (!blocks.length) { return; }
  ensureMermaid(function(ok) {
    if (!ok) {
      // Loading failed \u2014 reveal the source so the diagram code is still useful.
      blocks.forEach(function(b) {
        var src = b.querySelector('.mermaid-src'); if (src) { src.style.display = 'block'; }
        var t = b.querySelector('.mermaid-render'); if (t) { t.remove(); }
      });
      return;
    }
    var m = _getMermaid();
    blocks.forEach(function(b, idx) {
      if (b.dataset.rendered) { return; }
      var srcEl = b.querySelector('.mermaid-src code');
      var target = b.querySelector('.mermaid-render');
      if (!srcEl || !target) { return; }
      b.dataset.rendered = '1';
      var code = srcEl.textContent || '';
      var id = 'mmd-' + Date.now() + '-' + idx;
      try {
        Promise.resolve(m.render(id, code)).then(function(res) {
          target.innerHTML = (res && res.svg) ? res.svg : '';
        }).catch(function() {
          target.remove();
          var src = b.querySelector('.mermaid-src'); if (src) { src.style.display = 'block'; }
        });
      } catch (e) {
        target.remove();
        var src2 = b.querySelector('.mermaid-src'); if (src2) { src2.style.display = 'block'; }
      }
    });
  });
}

// ─── Line-by-line Markdown Parser ────────────────────────────────────────────
// noHighlight=true: skip syntax highlighting (used for the streaming tail so
// highlight() is never called repeatedly on every 500 ms render tick — it is
// only called once when a section is frozen into the DOM).
function parseMarkdown(md, noHighlight) {
  var lines = md.split('\\n');
  var out = [];
  var i = 0;
  var inUl = false, inOl = false, isChecklist = false;

  function flushList() {
    if (inUl) { out.push(isChecklist ? '</ul>' : '</ul>'); inUl = false; isChecklist = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  }

  function esc(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function inline(s) {
    s = s.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');
    s = s.replace(/\\*\\*\\*([^*]+)\\*\\*\\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\\n]+)__/g, '<strong>$1</strong>');
    s = s.replace(/\\*([^*\\n]+)\\*/g, '<em>$1</em>');
    s = s.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');
    return s;
  }

  function isBlockLine(ln) {
    return /^\\s*$/.test(ln) || /^#+\\s/.test(ln) || /^> /.test(ln) ||
           /^\`\`\`/.test(ln) || /^\\|/.test(ln) ||
           /^[\\-*+] /.test(ln) || /^\\d+[.)]\\s/.test(ln) || /^[\\-*_]{3,}\\s*$/.test(ln);
  }

  while (i < lines.length) {
    var line = lines[i];

    // ── Fenced code block ────────────────────────────────────────────────────
    if (/^\`\`\`/.test(line)) {
      flushList();
      var lang = line.replace(/^\`\`\`/, '').trim() || 'code';
      var codeAcc = [];
      i++;
      var closingFound = false;
      while (i < lines.length) {
        if (/^\`\`\`\s*$/.test(lines[i])) { closingFound = true; i++; break; }
        codeAcc.push(lines[i]); i++;
      }
      var codeBody = codeAcc.join('\\n');
      // Mermaid diagrams: emit a render target + hidden source (rendered later by
      // renderMermaidIn). Only on a complete, non-streaming block so we never try
      // to draw a half-written diagram.
      if (lang === 'mermaid' && closingFound && !noHighlight) {
        out.push(
          '<div class="code-wrap mermaid-wrap">' +
          '<div class="code-label">📊 mermaid diagram' +
            '<button class="code-copy-btn" onclick="copyCode(this)">Copy</button>' +
            '<button class="code-copy-btn" onclick="toggleMermaidSrc(this)">&lt;/&gt; Code</button>' +
          '</div>' +
          '<pre class="mermaid-src" style="display:none"><code>' + esc(codeBody) + '</code></pre>' +
          '<div class="mermaid-render"><div class="mmd-pending">📊 Rendering diagram…</div></div>' +
          '</div>'
        );
        continue;
      }
      // Only highlight when the block is closed AND we are not in the streaming
      // tail pass (noHighlight=true). This ensures highlight() is called at most
      // once per code block — when the section is frozen — never on every tick.
      var codeHtml = (closingFound && !noHighlight) ? highlight(codeBody, lang) : esc(codeBody);
      out.push(
        '<div class="code-wrap">' +
        '<div class="code-label">' + esc(lang) +
        (closingFound ? '<button class="code-copy-btn" onclick="copyCode(this)">Copy</button>' : '<span style="opacity:0.5;font-size:10px;margin-left:auto">streaming…</span>') +
        '</div>' +
        '<pre><code>' + codeHtml + '</code></pre>' +
        '</div>'
      );
      continue;
    }

    // ── Table (lines starting with |) ────────────────────────────────────────
    if (/^\\|/.test(line)) {
      flushList();
      var tRows = [];
      while (i < lines.length && /^\\|/.test(lines[i])) { tRows.push(lines[i]); i++; }
      var sepIdx = -1;
      for (var ti = 0; ti < tRows.length; ti++) {
        if (/^\\|[\\s\\-:|]+\\|/.test(tRows[ti])) { sepIdx = ti; break; }
      }
      var hRows = sepIdx > 0 ? tRows.slice(0, sepIdx) : [tRows[0]];
      var bRows = tRows.slice(sepIdx >= 0 ? sepIdx + 1 : 1);
      var thead = '<thead>' + hRows.map(function(r) {
        return '<tr>' + r.split('|').slice(1,-1).map(function(c) {
          return '<th>' + inline(esc(c.trim())) + '</th>';
        }).join('') + '</tr>';
      }).join('') + '</thead>';
      var tbody = '<tbody>' + bRows.map(function(r) {
        return '<tr>' + r.split('|').slice(1,-1).map(function(c) {
          return '<td>' + inline(esc(c.trim())) + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody>';
      out.push('<div class="table-wrap"><table>' + thead + tbody + '</table></div>');
      continue;
    }

    // ── Headings ─────────────────────────────────────────────────────────────
    var hm = line.match(/^(#{1,6})\\s+(.*)/);
    if (hm) {
      flushList();
      var hl = Math.min(hm[1].length, 6);
      out.push('<h' + hl + '>' + inline(esc(hm[2])) + '</h' + hl + '>');
      i++; continue;
    }

    // ── Horizontal rule ──────────────────────────────────────────────────────
    if (/^[\\-*_]{3,}\\s*$/.test(line)) {
      flushList(); out.push('<hr>'); i++; continue;
    }

    // ── Blockquote ───────────────────────────────────────────────────────────
    if (/^> /.test(line)) {
      flushList();
      var bqAcc = [];
      while (i < lines.length && /^> /.test(lines[i])) {
        bqAcc.push(inline(esc(lines[i].slice(2)))); i++;
      }
      out.push('<blockquote>' + bqAcc.join('<br>') + '</blockquote>');
      continue;
    }

    // ── Checklist ────────────────────────────────────────────────────────────
    if (/^- \\[[ xX]\\] /.test(line)) {
      if (!inUl || !isChecklist) { flushList(); out.push('<ul class="checklist">'); inUl = true; isChecklist = true; }
      var chk = (line[3] === 'x' || line[3] === 'X');
      out.push('<li><input type="checkbox"' + (chk ? ' checked' : '') + ' disabled> ' + inline(esc(line.slice(6))) + '</li>');
      i++; continue;
    }

    // ── Unordered list ───────────────────────────────────────────────────────
    if (/^(\\s*)[\\-*+] /.test(line)) {
      var ulm = line.match(/^(\\s*)[\\-*+] (.*)/);
      if (inOl || isChecklist) { flushList(); }
      if (!inUl) { out.push('<ul>'); inUl = true; }
      var ulIndent = ulm[1].length;
      out.push('<li style="margin-left:' + (ulIndent * 8) + 'px">' + inline(esc(ulm[2])) + '</li>');
      i++; continue;
    }

    // ── Ordered list ─────────────────────────────────────────────────────────
    if (/^\\d+[.)]\\s/.test(line)) {
      var olm = line.match(/^\\d+[.)]\\s+(.*)/);
      if (inUl) { flushList(); }
      if (!inOl) { out.push('<ol>'); inOl = true; }
      out.push('<li>' + inline(esc(olm ? olm[1] : line)) + '</li>');
      i++; continue;
    }

    // ── Empty line ───────────────────────────────────────────────────────────
    if (/^\\s*$/.test(line)) { flushList(); i++; continue; }

    // ── Paragraph (accumulate consecutive non-block lines) ───────────────────
    flushList();
    var pLines = [];
    while (i < lines.length && !isBlockLine(lines[i])) {
      pLines.push(inline(esc(lines[i]))); i++;
    }
    if (pLines.length) { out.push('<p>' + pLines.join('<br>') + '</p>'); }
    else { i++; } // safety: isBlockLine matched but no if-branch handled it (e.g. 7+ # heading) — advance to prevent infinite loop
  }

  flushList();
  return out.join('\\n');
}

// ─── Incremental Plan Renderer ───────────────────────────────────────────────
// Instead of re-running parseMarkdown on the ENTIRE plan on every render tick
// (O(n) and gets slower as the plan grows), we split by ## section headings and
// keep completed sections frozen in DOM divs.  Only the LAST (still-streaming)
// section is re-parsed each tick, keeping each render bounded to ~1–3 KB.
var _planFrozenCount = 0; // sections whose divs are finalized and won't be touched

/** Split planMarkdown into sections at top-level ## headings only.
 *  Lines inside fenced code blocks are never treated as headings,
 *  which was the root cause of the rendering freeze on code blocks. */
function splitPlanSections(md) {
  var lines = md.split('\\n');
  var sections = [];
  var current = [];
  var inFence = false;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    // Toggle fence state on opening/closing triple-backtick lines
    if (/^\`\`\`/.test(line)) { inFence = !inFence; }
    // Start a new section at every ## heading that is NOT inside a code fence
    if (!inFence && /^## /.test(line) && current.length > 0) {
      sections.push(current.join('\\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) { sections.push(current.join('\\n')); }
  return sections.length > 0 ? sections : [md];
}

function clearPlanDOM() {
  planRendered.innerHTML = '';
  _planFrozenCount = 0;
}

function renderPlanIncremental(isFinal) {
  if (!planMarkdown) { planRendered.innerHTML = ''; return; }
  var parts = splitPlanSections(planMarkdown);

  // How many sections to freeze on this call.
  // During streaming: freeze all except the last (still being written).
  // On final render: freeze everything.
  var freezeUpTo = isFinal ? parts.length : Math.max(parts.length - 1, 0);

  for (var s = _planFrozenCount; s < freezeUpTo; s++) {
    var div = planRendered.querySelector('div[data-ps="' + s + '"]');
    if (!div) {
      div = document.createElement('div');
      div.dataset.ps = String(s);
      planRendered.appendChild(div);
    }
    // Always skip highlight() here — renderPlanFull() applies it once at completion.
    // Calling highlight() on every section freeze caused up to 500ms UI blocks.
    div.innerHTML = parseMarkdown(parts[s], true);
    _planFrozenCount = s + 1;
  }

  if (!isFinal) {
    // Re-render only the currently-streaming tail section
    var lastIdx = parts.length - 1;
    var lastDiv = planRendered.querySelector('div[data-ps="' + lastIdx + '"]');
    if (!lastDiv) {
      lastDiv = document.createElement('div');
      lastDiv.dataset.ps = String(lastIdx);
      planRendered.appendChild(lastDiv);
    }
    // Pass noHighlight=true: the tail section re-renders every 500 ms while
    // streaming, so we must never call highlight() here — only on frozen divs.
    lastDiv.innerHTML = parseMarkdown(parts[lastIdx], true) + '<span class="stream-cursor"></span>';
  }
}

// Full re-render with syntax highlighting.
// Synchronous + atomic: builds all section divs into a DocumentFragment off-DOM,
// then swaps in one planRendered.innerHTML = '' + appendChild call so there is
// never a blank-screen window.  highlight() has a built-in >4000 char fast-path
// so cost per section is bounded; ~10-30 ms total for a typical plan.
function renderPlanFull() {
  if (!planMarkdown) { return; }
  var parts = splitPlanSections(planMarkdown);
  var frag = document.createDocumentFragment();
  for (var _rfi = 0; _rfi < parts.length; _rfi++) {
    var _rfd = document.createElement('div');
    _rfd.dataset.ps = String(_rfi);
    _rfd.innerHTML = parseMarkdown(parts[_rfi]); // WITH highlighting — called once per section
    frag.appendChild(_rfd);
  }
  // Atomic DOM swap — browser sees clear+populate as one paint operation
  planRendered.innerHTML = '';
  planRendered.appendChild(frag);
  _planFrozenCount = parts.length;
  renderMermaidIn(planRendered);
}

// ─── Plan generation progress placeholder ─────────────────────────────────────
// While a plan streams we show a progress card instead of rendering the partial
// markdown. Incrementally parsing half-written sections is fragile and can break
// the view, so renderPlanFull() renders the finished plan once at completion.
var _planProgress = { current: 0, total: 0, heading: '', phase: 'Generating migration plan…' };
function renderPlanProgressUI() {
  var pct = _planProgress.total ? Math.round((_planProgress.current / _planProgress.total) * 100) : 0;
  var counter = _planProgress.total
    ? 'Section ' + _planProgress.current + ' of ' + _planProgress.total
    : 'Starting…';
  var heading = _planProgress.heading
    ? '<div style="font-size:12px;opacity:0.7;margin-top:2px;max-width:440px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(_planProgress.heading) + '</div>'
    : '';
  planRendered.innerHTML =
    '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:14px;text-align:center;padding:24px">' +
      '<div class="dot-pulse"><span></span><span></span><span></span></div>' +
      '<div style="font-size:14px;font-weight:600">' + escapeHtml(_planProgress.phase) + '</div>' +
      '<div style="font-size:12px;opacity:0.8">' + counter + '</div>' +
      heading +
      '<div style="width:280px;max-width:80%;height:6px;border-radius:3px;background:var(--vscode-input-background,rgba(255,255,255,0.08));overflow:hidden;margin-top:6px">' +
        '<div style="height:100%;width:' + pct + '%;background:var(--vscode-button-background,#0e639c);transition:width 0.3s ease"></div>' +
      '</div>' +
      '<div style="font-size:11px;opacity:0.55;margin-top:4px">The full plan will appear here when generation finishes.</div>' +
    '</div>';
}

// ─── Agent team discussion UI (shared by Plan + Architecture) ─────────────────
// While a multi-agent run is in progress we show the live team conversation in
// the target tab. The finished output replaces it; the discussion is preserved
// behind a toggle in the header.
var _phaseLabel = { analysis: 'Analysis', discussion: 'Discussion', synthesis: 'Synthesis' };

// ── Generic, reusable building blocks (operate on explicit elements/stores) ──
function _rosterHTML(agents, title) {
  var chips = (agents || []).map(function(a) {
    return '<span class="team-chip"><span class="em">' + escapeHtml(a.emoji || '🧩') + '</span>' + escapeHtml(a.role) + '</span>';
  }).join('');
  return '<div class="team-roster"><div class="team-roster-title">' + title + '</div>' + chips + '</div>';
}

function _addBubble(threadEl, store, agentId, role, emoji, phase, scrollEl) {
  if (!threadEl) { return; }
  var wrap = document.createElement('div');
  wrap.className = 'agent-msg';
  var phaseCls = phase === 'synthesis' ? 'agent-phase synthesis' : 'agent-phase';
  wrap.innerHTML =
    '<div class="agent-avatar">' + escapeHtml(emoji || '🧩') + '</div>' +
    '<div class="agent-body">' +
      '<div class="agent-meta">' +
        '<span class="agent-name">' + escapeHtml(role || agentId) + '</span>' +
        '<span class="' + phaseCls + '">' + (_phaseLabel[phase] || phase) + '</span>' +
      '</div>' +
      '<div class="agent-text"></div>' +
    '</div>';
  threadEl.appendChild(wrap);
  store[agentId] = { wrap: wrap, body: wrap.querySelector('.agent-text'), raw: '' };
  _scrollNear(scrollEl);
}

function _bubbleChunk(store, agentId, chunk, scrollEl) {
  var b = store[agentId];
  if (!b) { return; }
  b.raw += chunk;
  // Plain text while streaming — safe and cheap; markdown is applied on end.
  b.body.textContent = b.raw;
  _scrollNear(scrollEl);
}

function _bubbleFinish(store, agentId, scrollEl) {
  var b = store[agentId];
  if (!b) { return; }
  if (b.raw.trim()) { b.body.innerHTML = parseMarkdown(b.raw, true); }
  _scrollNear(scrollEl);
}

function _ensureSynthBar(threadEl, defaultLabel) {
  if (!threadEl) { return null; }
  var sp = threadEl.querySelector('.synthesis-progress');
  if (!sp) {
    sp = document.createElement('div');
    sp.className = 'synthesis-progress';
    sp.innerHTML =
      '<div class="sp-row"><div class="dot-pulse"><span></span><span></span><span></span></div>' +
      '<span class="sp-label">' + defaultLabel + '</span></div>' +
      '<div class="sp-bar"><div class="sp-fill"></div></div>';
    threadEl.appendChild(sp);
  }
  return sp;
}

function _updateSynthBar(threadEl, defaultLabel, label, pct, scrollEl) {
  var sp = _ensureSynthBar(threadEl, defaultLabel);
  if (!sp) { return; }
  if (label) { sp.querySelector('.sp-label').textContent = label; }
  if (typeof pct === 'number') { sp.querySelector('.sp-fill').style.width = pct + '%'; }
  _scrollNear(scrollEl);
}

function _scrollNear(el) {
  if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 240) {
    el.scrollTop = el.scrollHeight;
  }
}

function _installTranscriptToggle(cfg) {
  // cfg: { html, btnId, panelId, headerEl, renderedEl, label, beforeBtn }
  if (!cfg.html) { return; }
  if (!cfg.headerEl || document.getElementById(cfg.btnId)) { return; }
  var btn = document.createElement('button');
  btn.id = cfg.btnId;
  btn.className = 'copy-btn';
  btn.title = cfg.label;
  btn.textContent = '💬 Team discussion';
  btn.addEventListener('click', function() {
    var existing = document.getElementById(cfg.panelId);
    if (existing) { existing.remove(); btn.style.background = ''; return; }
    var panel = document.createElement('div');
    panel.id = cfg.panelId;
    panel.style.cssText = 'margin-bottom:16px;padding:12px;border:1px solid var(--vscode-panel-border);border-radius:8px;background:var(--vscode-editor-inactiveSelectionBackground)';
    panel.innerHTML = '<div style="font-weight:600;margin-bottom:10px">' + cfg.label + '</div>' + cfg.html;
    cfg.renderedEl.insertBefore(panel, cfg.renderedEl.firstChild);
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    btn.style.background = 'var(--vscode-button-secondaryBackground)';
  });
  var before = cfg.beforeBtn && cfg.beforeBtn.parentNode ? cfg.beforeBtn : null;
  if (before) { before.parentNode.insertBefore(btn, before); }
  else { cfg.headerEl.appendChild(btn); }
}

// ── Plan-tab wrappers ──
function setupTeamUI(agents) {
  teamMode = true;
  teamAgents = agents || [];
  agentBubbles = {};
  planRendered.innerHTML =
    _rosterHTML(teamAgents, '🤝 Migration team assembled — ' + teamAgents.length + ' members') +
    '<div id="team-discussion"></div>';
}
function addAgentBubble(agentId, role, emoji, phase) {
  _addBubble(document.getElementById('team-discussion'), agentBubbles, agentId, role, emoji, phase, planRendered);
}
function appendAgentChunk(agentId, chunk) { _bubbleChunk(agentBubbles, agentId, chunk, planRendered); }
function finishAgentBubble(agentId) { _bubbleFinish(agentBubbles, agentId, planRendered); }
function updateSynthesisProgress(label, pct) {
  _updateSynthBar(document.getElementById('team-discussion'), 'Writing the migration plan…', label, pct, planRendered);
}
function installTeamTranscriptToggle() {
  _installTranscriptToggle({
    html: teamTranscriptHTML,
    btnId: 'btn-team-discussion',
    panelId: 'team-transcript-panel',
    headerEl: document.querySelector('#tab-plan .plan-header'),
    renderedEl: planRendered,
    label: '💬 How the team built this plan',
    beforeBtn: document.getElementById('btn-copy'),
  });
}

// ── Architecture-tab wrappers ──
function setupArchUI(agents) {
  archMode = true;
  archAgents = agents || [];
  archBubbles = {};
  archRendered.innerHTML =
    _rosterHTML(archAgents, '🏛️ Engineering team assembled — ' + archAgents.length + ' members') +
    '<div id="arch-discussion"></div>';
}
function addArchBubble(agentId, role, emoji, phase) {
  _addBubble(document.getElementById('arch-discussion'), archBubbles, agentId, role, emoji, phase, archRendered);
}
function appendArchChunk(agentId, chunk) { _bubbleChunk(archBubbles, agentId, chunk, archRendered); }
function finishArchBubble(agentId) { _bubbleFinish(archBubbles, agentId, archRendered); }
function updateArchSynthProgress(label, pct) {
  _updateSynthBar(document.getElementById('arch-discussion'), 'Writing the documentation…', label, pct, archRendered);
}
function installArchTranscriptToggle() {
  _installTranscriptToggle({
    html: archTranscriptHTML,
    btnId: 'btn-arch-discussion',
    panelId: 'arch-transcript-panel',
    headerEl: document.querySelector('#tab-architecture .plan-header'),
    renderedEl: archRendered,
    label: '💬 How the team wrote this documentation',
    beforeBtn: document.getElementById('btn-arch-copy'),
  });
}
function renderArchProgressUI(phase) {
  archRendered.innerHTML =
    '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:14px;text-align:center;padding:24px">' +
      '<div class="dot-pulse"><span></span><span></span><span></span></div>' +
      '<div style="font-size:14px;font-weight:600">' + escapeHtml(phase || 'Preparing…') + '</div>' +
      '<div style="font-size:11px;opacity:0.55;margin-top:4px">The documentation will appear here when it is ready.</div>' +
    '</div>';
}
function renderArchFull() {
  if (!archMarkdown) { return; }
  var parts = splitPlanSections(archMarkdown);
  var frag = document.createDocumentFragment();
  for (var i = 0; i < parts.length; i++) {
    var d = document.createElement('div');
    d.innerHTML = parseMarkdown(parts[i]);
    frag.appendChild(d);
  }
  archRendered.innerHTML = '';
  archRendered.appendChild(frag);
  renderMermaidIn(archRendered);
}

// ── Security-tab wrappers ──
function setupSecUI(agents) {
  secMode = true;
  secAgents = agents || [];
  secBubbles = {};
  secRendered.innerHTML =
    _rosterHTML(secAgents, '🛡️ Security team assembled — ' + secAgents.length + ' members') +
    '<div id="sec-discussion"></div>';
}
function addSecBubble(agentId, role, emoji, phase) {
  _addBubble(document.getElementById('sec-discussion'), secBubbles, agentId, role, emoji, phase, secRendered);
}
function appendSecChunk(agentId, chunk) { _bubbleChunk(secBubbles, agentId, chunk, secRendered); }
function finishSecBubble(agentId) { _bubbleFinish(secBubbles, agentId, secRendered); }
function updateSecSynthProgress(label, pct) {
  _updateSynthBar(document.getElementById('sec-discussion'), 'Writing the vulnerability report…', label, pct, secRendered);
}
function installSecTranscriptToggle() {
  _installTranscriptToggle({
    html: secTranscriptHTML,
    btnId: 'btn-sec-discussion',
    panelId: 'sec-transcript-panel',
    headerEl: document.querySelector('#tab-security-audit .plan-header'),
    renderedEl: secRendered,
    label: '💬 How the team found these issues',
    beforeBtn: document.getElementById('btn-sec-copy'),
  });
}
function renderSecProgressUI(phase) {
  secRendered.innerHTML =
    '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:14px;text-align:center;padding:24px">' +
      '<div class="dot-pulse"><span></span><span></span><span></span></div>' +
      '<div style="font-size:14px;font-weight:600">' + escapeHtml(phase || 'Preparing…') + '</div>' +
      '<div style="font-size:11px;opacity:0.55;margin-top:4px">The severity-sorted report will appear here when it is ready.</div>' +
    '</div>';
}
function renderSecFull() {
  if (!secMarkdown) { return; }
  var parts = splitPlanSections(secMarkdown);
  var frag = document.createDocumentFragment();
  for (var i = 0; i < parts.length; i++) {
    var d = document.createElement('div');
    d.innerHTML = parseMarkdown(parts[i]);
    frag.appendChild(d);
  }
  secRendered.innerHTML = '';
  secRendered.appendChild(frag);
  renderMermaidIn(secRendered);
}
// Count findings by severity tag and show a colour-coded summary in the header.
function renderSecSummary() {
  var sevs = [
    { key: 'critical', label: 'Critical', color: '#e53935' },
    { key: 'high',     label: 'High',     color: '#fb8c00' },
    { key: 'medium',   label: 'Medium',   color: '#fdd835' },
    { key: 'low',      label: 'Low',      color: '#43a047' },
  ];
  var lower = secMarkdown.toLowerCase();
  var total = 0;
  var html = sevs.map(function(s) {
    // Count literal "[critical]" etc. via split — avoids regex-escape pitfalls.
    var n = lower.split('[' + s.key + ']').length - 1;
    total += n;
    return '<span class="team-chip" style="border:1px solid ' + s.color + '"><span class="em" style="color:' + s.color + '">●</span>' + s.label + ': ' + n + '</span>';
  }).join('');
  if (total === 0) { secSummary.style.display = 'none'; return; }
  secSummary.innerHTML = html;
  secSummary.style.display = 'flex';
}

// ── Correction-tab wrappers ──
function setupCorrUI(agents) {
  corrMode = true;
  corrAgents = agents || [];
  corrBubbles = {};
  corrRendered.innerHTML =
    _rosterHTML(corrAgents, '🛠️ Correction team assembled — ' + corrAgents.length + ' members') +
    '<div id="corr-discussion"></div>';
}
function addCorrBubble(agentId, role, emoji, phase) {
  _addBubble(document.getElementById('corr-discussion'), corrBubbles, agentId, role, emoji, phase, corrRendered);
}
function appendCorrChunk(agentId, chunk) { _bubbleChunk(corrBubbles, agentId, chunk, corrRendered); }
function finishCorrBubble(agentId) { _bubbleFinish(corrBubbles, agentId, corrRendered); }
function updateCorrSynthProgress(label, pct) {
  _updateSynthBar(document.getElementById('corr-discussion'), 'Writing the correction plan…', label, pct, corrRendered);
}
function installCorrTranscriptToggle() {
  _installTranscriptToggle({
    html: corrTranscriptHTML,
    btnId: 'btn-corr-discussion',
    panelId: 'corr-transcript-panel',
    headerEl: document.querySelector('#tab-correction .plan-header'),
    renderedEl: corrRendered,
    label: '💬 How the team built this plan',
    beforeBtn: document.getElementById('btn-corr-copy'),
  });
}
function renderCorrProgressUI(phase) {
  corrRendered.innerHTML =
    '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:14px;text-align:center;padding:24px">' +
      '<div class="dot-pulse"><span></span><span></span><span></span></div>' +
      '<div style="font-size:14px;font-weight:600">' + escapeHtml(phase || 'Preparing…') + '</div>' +
      '<div style="font-size:11px;opacity:0.55;margin-top:4px">🔒 No business logic will be changed. The plan appears here when ready.</div>' +
    '</div>';
}
function renderCorrFull() {
  if (!corrMarkdown) { return; }
  var parts = splitPlanSections(corrMarkdown);
  var frag = document.createDocumentFragment();
  for (var i = 0; i < parts.length; i++) {
    var d = document.createElement('div');
    d.innerHTML = parseMarkdown(parts[i]);
    frag.appendChild(d);
  }
  corrRendered.innerHTML = '';
  corrRendered.appendChild(frag);
  renderMermaidIn(corrRendered);
}
// Build the scope dropdowns from the analyzed project's sub-repos.
function populateCorrScope(analysis) {
  const subs = (analysis && analysis.subRepos) || [];
  const opts = ['<option value="">Whole project' + (subs.length ? ' (' + subs.length + ' repos)' : '') + '</option>']
    .concat(subs.map((s) => '<option value="' + escapeHtml(s) + '">Only: ' + escapeHtml(s) + '</option>'));
  corrScope.innerHTML = opts.join('');
  corrScope2.innerHTML = opts.join('');
}

// ─── Table of Contents (TOC) ──────────────────────────────────────────────────
// Throttled build: fires at most once per 800 ms while streaming
var _tocThrottle = null;
function buildToc(md) {
  if (_tocThrottle) { return; }
  _tocThrottle = setTimeout(function() { _tocThrottle = null; _buildTocNow(md); }, 800);
}
function _buildTocNow(md) {
  if (!tocList) { return; }
  var lines = md.split('\\n');
  var headings = [];
  for (var li = 0; li < lines.length; li++) {
    var hm = lines[li].match(/^(#{1,3}) (.+)/);
    if (hm) { headings.push({ level: hm[1].length, text: hm[2].replace(/\\*\\*/g, '').trim() }); }
  }
  if (headings.length < 2) {
    if (planToc) { planToc.style.display = 'none'; }
    if (btnTocToggle) { btnTocToggle.style.display = 'none'; }
    return;
  }
  tocList.innerHTML = '';
  headings.forEach(function(h) {
    var li = document.createElement('li');
    li.className = 'toc-h' + h.level;
    var a = document.createElement('a');
    a.textContent = h.text.replace(/^\\d+\\.\\s*/, '');
    a.href = '#';
    a.addEventListener('click', function(hCopy) {
      return function(e) {
        e.preventDefault();
        var all = planRendered.querySelectorAll('h1,h2,h3');
        var needle = hCopy.text.slice(0, 40).toLowerCase();
        for (var j = 0; j < all.length; j++) {
          if (all[j].textContent.trim().toLowerCase().startsWith(needle.slice(0, 20))) {
            all[j].scrollIntoView({ behavior: 'smooth', block: 'start' });
            tocList.querySelectorAll('a').forEach(function(x) { x.classList.remove('toc-active'); });
            a.classList.add('toc-active');
            break;
          }
        }
      };
    }(h));
    li.appendChild(a);
    tocList.appendChild(li);
  });
  btnTocToggle.style.display = 'inline-flex';
  // Auto-open the first time enough headings appear, unless user closed it
  if (headings.length >= 3 && planToc.style.display === 'none' && !planToc.dataset.userClosed) {
    planToc.style.display = 'block';
    btnTocToggle.style.background = 'var(--vscode-button-secondaryBackground)';
  }
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
