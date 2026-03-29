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
exports.MigrationPanel = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const githubAnalyzer_1 = require("./githubAnalyzer");
const copilotService_1 = require("./copilotService");
const reportGenerator_1 = require("./reportGenerator");
const CACHE_KEY = 'migrationAssistant.analysisCache';
const HISTORY_KEY = 'migrationAssistant.history';
const MAX_HISTORY = 8;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const TOKEN_SECRET_KEY = 'migrationAssistant.githubToken';
class MigrationPanel {
    // ─── Static Factory ──────────────────────────────────────────────────────────
    static createOrShow(context) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;
        if (MigrationPanel.currentPanel) {
            MigrationPanel.currentPanel._panel.reveal(column);
            return MigrationPanel.currentPanel;
        }
        const panel = vscode.window.createWebviewPanel(MigrationPanel.viewType, 'Migration Assistant', column || vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [context.extensionUri],
        });
        MigrationPanel.currentPanel = new MigrationPanel(panel, context.extensionUri, context.secrets, context.globalState);
        return MigrationPanel.currentPanel;
    }
    // ─── Constructor ──────────────────────────────────────────────────────────────
    constructor(panel, extensionUri, secrets, globalState) {
        this._disposables = [];
        this._lastPlan = '';
        this._chatHistory = [];
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._secrets = secrets;
        this._globalState = globalState;
        this._panel.webview.html = this._getWebviewContent();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage((msg) => {
            this._handleMessage(msg).catch((err) => {
                this._post({ type: 'error', message: `Internal error: ${err?.message ?? String(err)}` });
            });
        }, null, this._disposables);
    }
    // ─── Message Handler ──────────────────────────────────────────────────────────
    async _handleMessage(msg) {
        switch (msg.type) {
            case 'ready':
                await this._sendSettings();
                this._post({ type: 'historyLoaded', entries: this._getHistory() });
                // Populate model dropdown with live Copilot models
                (0, copilotService_1.getAvailableModels)().then(models => {
                    if (models.length > 0) {
                        this._post({ type: 'modelsLoaded', models });
                    }
                }).catch(() => { });
                break;
            case 'analyze':
                await this._runAnalysis(msg.repoUrl, msg.githubToken);
                break;
            case 'generatePlan':
                if (!this._lastAnalysis) {
                    this._post({ type: 'error', message: 'Please analyze a repository first.' });
                    return;
                }
                await this._runMigrationPlan(this._lastAnalysis, msg.targetStack, msg.options);
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
                this._loadFromHistory(msg.historyId);
                break;
            case 'removeFromHistory':
                this._removeFromHistory(msg.historyId);
                break;
            case 'clearHistory':
                await this._globalState.update(HISTORY_KEY, []);
                this._post({ type: 'historyLoaded', entries: [] });
                break;
            case 'addToQueue':
                if (msg.queueUrls?.length) {
                    await this._runQueue(msg.queueUrls, msg.githubToken, msg.targetStack, msg.options);
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
                await this._runOrgAnalysis(msg.orgUrl, msg.githubToken);
                break;
            case 'checkProgress':
                await this._runProgressCheck(msg.branch ?? '');
                break;
            case 'generateFilePreviews':
                await this._runFilePreviews(msg.targetStack);
                break;
            case 'getExecSummary':
                await this._runExecSummary(msg.targetStack);
                break;
            case 'generateReport':
                await this._generateReport(msg.targetStack, msg.reportFormat ?? 'word');
                break;
            case 'generateJiraStories':
                await this._generateJiraStories(msg.targetStack, msg.jiraConfig);
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
                await this.applyPendingPlanPatch();
                break;
            case 'openSettings':
                vscode.commands.executeCommand('workbench.action.openSettings', 'migrationAssistant');
                break;
        }
    }
    // ─── Send Saved Settings ──────────────────────────────────────────────────────
    async _sendSettings() {
        const config = vscode.workspace.getConfiguration('migrationAssistant');
        // Load token from SecretStorage (encrypted), not plain settings
        const githubToken = await this._secrets.get(TOKEN_SECRET_KEY) ?? '';
        const copilotModel = config.get('copilotModel', 'gpt-4o');
        this._post({ type: 'settingsLoaded', settings: { githubToken, copilotModel } });
    }
    // ─── Analysis ─────────────────────────────────────────────────────────────────
    async _runAnalysis(repoUrl, githubToken) {
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
            this._post({ type: 'analysisComplete', analysis: cached.analysis });
            this._post({ type: 'cacheHit', cachedAt: cached.timestamp });
            this._generateAndPostPresets(cached.analysis);
            return;
        }
        try {
            const analysis = await (0, githubAnalyzer_1.analyzeRepository)(repoUrl, token, (message, step, total) => {
                this._post({ type: 'progress', message, step, totalSteps: total });
            });
            this._setCachedAnalysis(repoUrl, analysis);
            this._lastAnalysis = analysis;
            this._post({ type: 'analysisComplete', analysis });
            this._generateAndPostPresets(analysis);
        }
        catch (err) {
            this._post({ type: 'error', message: err.message || String(err) });
        }
    }
    /** Fire-and-forget: generate AI presets and send them to the webview. */
    _generateAndPostPresets(analysis) {
        const cts = new vscode.CancellationTokenSource();
        (0, copilotService_1.generatePresets)(analysis, cts.token)
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
    async _runMigrationPlan(analysis, targetStack, options) {
        // ── Security confirmation before any code leaves the machine ──────────────
        const { redactionSummary, repoInfo, keyFiles } = analysis;
        const isEnterprise = !repoInfo.owner.includes('github.com'); // non-public host
        const filesSent = keyFiles.map((f) => f.path).join(', ');
        const confirmLines = [
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
        const choice = await vscode.window.showWarningMessage(confirmLines.join('\n'), { modal: true }, 'Send to Copilot', 'Cancel');
        if (choice !== 'Send to Copilot') {
            this._post({ type: 'stopped' });
            return;
        }
        // ─────────────────────────────────────────────────────────────────────────
        this._cancellationSource?.cancel();
        this._cancellationSource = new vscode.CancellationTokenSource();
        const token = this._cancellationSource.token;
        this._lastPlan = '';
        this._chatHistory = []; // new plan = fresh chat context
        this._post({ type: 'planChunk', chunk: '' }); // clear signal
        try {
            await (0, copilotService_1.streamMigrationPlan)(analysis, targetStack, options, (chunk) => {
                this._lastPlan += chunk;
                this._post({ type: 'planChunk', chunk });
            }, token);
            this._post({ type: 'planComplete' });
            // Persist for progress check / exec summary
            const cfg = vscode.workspace.getConfiguration('migrationAssistant');
            await cfg.update('lastTargetStack', targetStack, vscode.ConfigurationTarget.Global);
            // Save to history (enhancement #9)
            await this._saveToHistory(analysis, targetStack, this._lastPlan);
            // Reload history in UI
            this._post({ type: 'historyLoaded', entries: this._getHistory() });
        }
        catch (err) {
            if (token.isCancellationRequested) {
                this._post({ type: 'stopped' });
            }
            else {
                this._post({ type: 'error', message: err.message || String(err) });
            }
        }
    }
    // ─── Cache (enhancement #4) ───────────────────────────────────────────────────
    _getCachedAnalysis(repoUrl) {
        const all = this._globalState.get(CACHE_KEY, {});
        const entry = all[repoUrl];
        if (!entry) {
            return undefined;
        }
        if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
            delete all[repoUrl];
            this._globalState.update(CACHE_KEY, all);
            return undefined;
        }
        return entry;
    }
    _setCachedAnalysis(repoUrl, analysis) {
        const all = this._globalState.get(CACHE_KEY, {});
        all[repoUrl] = { repoUrl, analysis, timestamp: Date.now() };
        this._globalState.update(CACHE_KEY, all);
    }
    // ─── History (enhancement #9) ─────────────────────────────────────────────────
    _getHistory() {
        return this._globalState.get(HISTORY_KEY, []);
    }
    async _saveToHistory(analysis, targetStack, plan) {
        const entries = this._getHistory();
        const entry = {
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
    _loadFromHistory(id) {
        const entry = this._getHistory().find((e) => e.id === id);
        if (!entry) {
            return;
        }
        this._lastPlan = entry.plan;
        this._lastAnalysis = entry.analysis; // restore so debug/exec-summary/progress-check work
        this._chatHistory = []; // fresh context for this history entry
        // Replay the plan as chunks so the UI renders it
        this._post({ type: 'planChunk', chunk: '' });
        this._post({ type: 'planChunk', chunk: entry.plan });
        this._post({ type: 'planComplete' });
    }
    async _removeFromHistory(id) {
        const entries = this._getHistory().filter((e) => e.id !== id);
        await this._globalState.update(HISTORY_KEY, entries);
        this._post({ type: 'historyLoaded', entries });
    }
    // ─── Token Validation (enhancement #12) ──────────────────────────────────────
    async _validateToken(githubToken, repoUrl) {
        const token = githubToken || await this._secrets.get(TOKEN_SECRET_KEY);
        if (!token) {
            this._post({ type: 'tokenValidation', isValid: false, message: 'No token provided.' });
            return;
        }
        try {
            const result = await this._githubUserCheck(token, repoUrl);
            this._post({ type: 'tokenValidation', isValid: true, username: result });
        }
        catch (err) {
            this._post({ type: 'tokenValidation', isValid: false, message: err.message });
        }
    }
    async _githubUserCheck(token, repoUrl) {
        const headers = {
            'User-Agent': 'vscode-migration-assistant/1.0',
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
        };
        const fetchJson = async (url) => {
            const res = await fetch(url, { headers });
            return { status: res.status, body: await res.json() };
        };
        // 1️⃣ Try /user — works when the classic PAT has any read scope
        try {
            const { status, body } = await fetchJson('https://api.github.com/user');
            if (status === 200) {
                return body.login ?? 'authenticated';
            }
        }
        catch { /* fall through */ }
        // 2️⃣ Try /rate_limit — works with any valid token regardless of scopes
        try {
            const { status, body } = await fetchJson('https://api.github.com/rate_limit');
            if (status === 200) {
                const core = body?.resources?.core;
                const limit = core?.limit ?? 0;
                const remaining = core?.remaining ?? 0;
                if (limit >= 5000) {
                    return `authenticated (${remaining}/${limit} requests remaining)`;
                }
            }
        }
        catch { /* fall through */ }
        // 3️⃣ Last resort — try the actual repo the user entered.
        //    This is exactly the endpoint the analysis uses, so if it works the token is fine.
        if (repoUrl) {
            try {
                const { parseGitHubUrl } = await Promise.resolve().then(() => __importStar(require('./githubAnalyzer')));
                const { owner, repo, hostname } = parseGitHubUrl(repoUrl);
                const apiBase = hostname === 'github.com' ? 'https://api.github.com' : `https://${hostname}/api/v3`;
                const { status } = await fetchJson(`${apiBase}/repos/${owner}/${repo}`);
                if (status === 200) {
                    return `token works for ${owner}/${repo}`;
                }
            }
            catch { /* fall through */ }
        }
        throw new Error('Could not verify token against GitHub API. ' +
            'If repository analysis works, your token is valid — ' +
            'your organisation may restrict the /user endpoint (SAML SSO or scope policy).');
    }
    // ─── Save Plan as .md (enhancement #2) ───────────────────────────────────────
    async _savePlanToFile(plan) {
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
    async _runQueue(urls, githubToken, targetStack, options) {
        const storedToken = await this._secrets.get(TOKEN_SECRET_KEY);
        const token = githubToken || storedToken || undefined;
        for (let i = 0; i < urls.length; i++) {
            const repoUrl = urls[i].trim();
            if (!repoUrl) {
                continue;
            }
            this._post({ type: 'queueProgress', queueIndex: i + 1, queueTotal: urls.length, queueRepo: repoUrl });
            try {
                const cached = this._getCachedAnalysis(repoUrl);
                const analysis = cached?.analysis ?? await (0, githubAnalyzer_1.analyzeRepository)(repoUrl, token, (message, step, total) => this._post({ type: 'progress', message: `[${i + 1}/${urls.length}] ${message}`, step, totalSteps: total }));
                if (!cached) {
                    this._setCachedAnalysis(repoUrl, analysis);
                }
                this._lastAnalysis = analysis;
                this._post({ type: 'analysisComplete', analysis });
                await this._runMigrationPlan(analysis, targetStack, options);
            }
            catch (err) {
                this._post({ type: 'error', message: `[${repoUrl}] ${err.message}` });
            }
        }
    }
    // ─── Debug Helper (enhancement #3) ───────────────────────────────────────────
    async _runDebugHelper(errorMessage) {
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
            await (0, copilotService_1.streamDebugHelp)(this._lastAnalysis, errorMessage, (chunk) => this._post({ type: 'debugChunk', chunk }), this._cancellationSource.token);
            this._post({ type: 'debugComplete' });
        }
        catch (err) {
            this._post({ type: 'error', message: err.message });
        }
    }
    // ─── Executive Summary (enhancement #5) ──────────────────────────────────────
    async _runExecSummary(targetStack) {
        if (!this._lastAnalysis || !this._lastPlan) {
            this._post({ type: 'error', message: 'Generate a migration plan first.' });
            return;
        }
        this._cancellationSource?.cancel();
        this._cancellationSource = new vscode.CancellationTokenSource();
        this._post({ type: 'execSummaryChunk', chunk: '' });
        try {
            await (0, copilotService_1.streamExecSummary)(this._lastAnalysis, targetStack, this._lastPlan, (chunk) => this._post({ type: 'execSummaryChunk', chunk }), this._cancellationSource.token);
            this._post({ type: 'execSummaryComplete' });
        }
        catch (err) {
            this._post({ type: 'error', message: err.message });
        }
    }
    // ─── File Previews (enhancement #1) ──────────────────────────────────────────
    async _runFilePreviews(targetStack) {
        if (!this._lastAnalysis) {
            this._post({ type: 'error', message: 'Analyze a repository first.' });
            return;
        }
        this._cancellationSource?.cancel();
        this._cancellationSource = new vscode.CancellationTokenSource();
        this._post({ type: 'previewChunk', chunk: '' });
        try {
            await (0, copilotService_1.streamFilePreviews)(this._lastAnalysis, targetStack, (chunk) => this._post({ type: 'previewChunk', chunk }), this._cancellationSource.token);
            this._post({ type: 'previewComplete' });
        }
        catch (err) {
            this._post({ type: 'error', message: err.message });
        }
    }
    // ─── Stack Recommendations ────────────────────────────────────────────────────
    async _runStackRecommendations() {
        if (!this._lastAnalysis) {
            this._post({ type: 'error', message: 'Analyze a repository first.' });
            return;
        }
        this._cancellationSource?.cancel();
        this._cancellationSource = new vscode.CancellationTokenSource();
        this._post({ type: 'stackRecsChunk', chunk: '' });
        try {
            await (0, copilotService_1.streamStackRecommendations)(this._lastAnalysis, (chunk) => this._post({ type: 'stackRecsChunk', chunk }), this._cancellationSource.token);
            this._post({ type: 'stackRecsComplete' });
        }
        catch (err) {
            this._post({ type: 'error', message: err.message });
        }
    }
    // ─── AI Stack Detection ───────────────────────────────────────────────────────
    async _runAIStackDetection() {
        if (!this._lastAnalysis) {
            return;
        }
        this._cancellationSource?.cancel();
        this._cancellationSource = new vscode.CancellationTokenSource();
        try {
            const aiStack = await (0, copilotService_1.detectStackWithAI)(this._lastAnalysis, this._cancellationSource.token);
            this._post({ type: 'aiStackDetected', aiStack });
        }
        catch {
            // Silent — fallback to rule-based stack already shown
        }
    }
    // ─── Stack Health Analysis ────────────────────────────────────────────────────
    async _runStackHealthAnalysis() {
        if (!this._lastAnalysis) {
            this._post({ type: 'error', message: 'Analyze a repository first.' });
            return;
        }
        this._cancellationSource?.cancel();
        this._cancellationSource = new vscode.CancellationTokenSource();
        this._post({ type: 'stackHealthChunk', chunk: '' });
        try {
            await (0, copilotService_1.streamStackHealthAnalysis)(this._lastAnalysis, (chunk) => this._post({ type: 'stackHealthChunk', chunk }), this._cancellationSource.token);
            this._post({ type: 'stackHealthComplete' });
        }
        catch (err) {
            this._post({ type: 'error', message: err.message });
        }
    }
    // ─── Export Plan (enhancement #4) ────────────────────────────────────────────
    async _exportPlan(format) {
        if (!this._lastPlan || !this._lastAnalysis) {
            this._post({ type: 'error', message: 'Generate a plan first.' });
            return;
        }
        // Exec summary is its own streaming flow
        if (format === 'exec-summary') {
            const config = vscode.workspace.getConfiguration('migrationAssistant');
            const targetStack = config.get('lastTargetStack', 'target stack');
            await this._runExecSummary(targetStack);
            return;
        }
        this._cancellationSource?.cancel();
        this._cancellationSource = new vscode.CancellationTokenSource();
        this._post({ type: 'exportReady', exportFormat: format, exportContent: '' });
        const config2 = vscode.workspace.getConfiguration('migrationAssistant');
        const exportTargetStack = config2.get('lastTargetStack', 'target stack');
        try {
            let content = '';
            await (0, copilotService_1.streamExportFormat)(this._lastPlan, format, this._lastAnalysis.repoInfo.repo, exportTargetStack, (chunk) => { content += chunk; this._post({ type: 'exportReady', exportFormat: format, exportContent: content }); }, this._cancellationSource.token);
        }
        catch (err) {
            this._post({ type: 'error', message: err.message });
        }
    }
    // ─── Org Dashboard (enhancement #7) ──────────────────────────────────────────
    async _runOrgAnalysis(orgUrl, githubToken) {
        const storedToken = await this._secrets.get(TOKEN_SECRET_KEY);
        const token = githubToken || storedToken || undefined;
        try {
            const dashboard = await (0, githubAnalyzer_1.analyzeOrg)(orgUrl, token, (msg, done, total) => this._post({ type: 'progress', message: msg, step: done, totalSteps: total }));
            this._post({ type: 'orgDashboard', dashboard });
        }
        catch (err) {
            this._post({ type: 'error', message: err.message });
        }
    }
    // ─── Progress Check (enhancement #8) ─────────────────────────────────────────
    async _runProgressCheck(compareBranch) {
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
            const diff = await (0, githubAnalyzer_1.fetchBranchDiff)(owner, repo, base, compare, storedToken || undefined, hostname);
            const config = vscode.workspace.getConfiguration('migrationAssistant');
            const targetStack = config.get('lastTargetStack', 'target stack');
            await (0, copilotService_1.streamProgressCheck)(this._lastAnalysis, targetStack, this._lastPlan, diff, (chunk) => this._post({ type: 'progressChunk', chunk }), this._cancellationSource.token);
            this._post({ type: 'progressComplete' });
        }
        catch (err) {
            this._post({ type: 'error', message: err.message });
        }
    }
    // ─── Interactive Chat ─────────────────────────────────────────────────────────
    async _runChat(question) {
        if (!this._lastPlan || !this._lastAnalysis) {
            this._post({ type: 'error', message: 'Generate a migration plan first before using the chat.' });
            return;
        }
        if (!question.trim()) {
            return;
        }
        // Push the user's message into history immediately
        this._chatHistory.push({ role: 'user', content: question, timestamp: Date.now() });
        this._cancellationSource?.cancel();
        this._cancellationSource = new vscode.CancellationTokenSource();
        const config = vscode.workspace.getConfiguration('migrationAssistant');
        const targetStack = config.get('lastTargetStack', 'target stack');
        let replyBuffer = '';
        this._post({ type: 'chatChunk', chunk: '' }); // signal: new assistant turn starting
        try {
            await (0, copilotService_1.streamChatReply)(this._lastAnalysis, this._lastPlan, targetStack, this._chatHistory, question, (chunk) => {
                replyBuffer += chunk;
                this._post({ type: 'chatChunk', chunk });
            }, this._cancellationSource.token);
            // Persist the completed assistant reply in history
            this._chatHistory.push({ role: 'assistant', content: replyBuffer, timestamp: Date.now() });
            this._post({ type: 'chatComplete' });
        }
        catch (err) {
            if (this._cancellationSource.token.isCancellationRequested) {
                this._post({ type: 'chatComplete' });
            }
            else {
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
                const intent = await (0, copilotService_1.detectStackChangeIntent)(question, this._lastPlan, intentToken.token);
                intentToken.dispose();
                if (intent && intent.fromComponent && intent.toComponent) {
                    this._pendingStackChange = intent;
                    // Notify the UI so it can show a "Apply to plan" confirmation banner
                    this._post({ type: 'stackChangeDetected', stackChangeIntent: intent });
                }
            }
            catch {
                // Intent detection is best-effort — never surface errors to the user
            }
        }
    }
    // ─── Apply Plan Patch ─────────────────────────────────────────────────────────
    async applyPendingPlanPatch() {
        const intent = this._pendingStackChange;
        if (!intent || !this._lastAnalysis || !this._lastPlan) {
            this._post({ type: 'error', message: 'No pending stack change to apply.' });
            return;
        }
        this._pendingStackChange = undefined;
        this._cancellationSource?.cancel();
        this._cancellationSource = new vscode.CancellationTokenSource();
        // Signal the UI that the plan is being rewritten
        this._post({ type: 'planPatchChunk', chunk: '' });
        try {
            await (0, copilotService_1.streamPlanPatch)(this._lastAnalysis, this._lastPlan, intent, (chunk) => this._post({ type: 'planPatchChunk', chunk }), (patchedPlan) => {
                this._lastPlan = patchedPlan;
                this._post({ type: 'planPatchComplete', patchedPlan });
            }, this._cancellationSource.token);
        }
        catch (err) {
            this._post({ type: 'error', message: err.message || String(err) });
        }
    }
    // ─── Helpers ──────────────────────────────────────────────────────────────────
    _post(msg) {
        this._panel.webview.postMessage(msg);
    }
    dispose() {
        MigrationPanel.currentPanel = undefined;
        this._cancellationSource?.cancel();
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            d?.dispose();
        }
    }
    // ─── Detailed Report Generation ───────────────────────────────────────────────
    async _generateReport(targetStack, format) {
        if (!this._lastAnalysis) {
            this._post({ type: 'error', message: 'Analyze a repository first.' });
            return;
        }
        const resolvedTarget = targetStack ||
            (vscode.workspace.getConfiguration('migrationAssistant').get('lastTargetStack') ?? 'modern stack');
        this._post({ type: 'progress', message: 'Generating detailed report via Copilot…', step: 1, totalSteps: 3 });
        this._cancellationSource?.cancel();
        this._cancellationSource = new vscode.CancellationTokenSource();
        const token = this._cancellationSource.token;
        let fullReport = '';
        let reportChunkCount = 0;
        try {
            await (0, copilotService_1.streamDetailedReport)(this._lastAnalysis, resolvedTarget, (chunk) => {
                fullReport += chunk;
                // Animate progress bar as content streams in (step 1 of 3 = 0–33%)
                reportChunkCount++;
                if (reportChunkCount % 5 === 0) {
                    const pct = Math.min(30, reportChunkCount * 0.3);
                    this._post({ type: 'progress', message: `Receiving report content… (${fullReport.length} chars)`, step: pct, totalSteps: 100 });
                }
            }, token);
        }
        catch (err) {
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
            let fileBuffer;
            let defaultName;
            let filters;
            if (format === 'word') {
                const buf = await (0, reportGenerator_1.generateWordReport)(fullReport, this._lastAnalysis, resolvedTarget);
                fileBuffer = new Uint8Array(buf);
                defaultName = `${this._lastAnalysis.repoInfo.repo}-migration-report.docx`;
                filters = { 'Word Document': ['docx'] };
            }
            else {
                const html = (0, reportGenerator_1.generateHtmlReport)(fullReport, this._lastAnalysis, resolvedTarget);
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
                vscode.window.showInformationMessage(`Migration report saved: ${path.basename(saveUri.fsPath)}`, 'Open').then(action => {
                    if (action === 'Open') {
                        vscode.env.openExternal(saveUri);
                    }
                });
            }
        }
        catch (err) {
            this._post({ type: 'reportError', message: err.message || String(err) });
        }
    }
    // ─── Jira Stories Generation ────────────────────────────────────────────────
    async _generateJiraStories(targetStack, config) {
        if (!this._lastAnalysis || !this._lastPlan) {
            this._post({ type: 'error', message: 'Generate a migration plan first.' });
            return;
        }
        const resolvedTarget = targetStack ||
            (vscode.workspace.getConfiguration('migrationAssistant').get('lastTargetStack') ?? 'modern stack');
        this._cancellationSource?.cancel();
        this._cancellationSource = new vscode.CancellationTokenSource();
        const token = this._cancellationSource.token;
        try {
            const stories = await (0, copilotService_1.streamJiraStories)(this._lastAnalysis, resolvedTarget, this._lastPlan, config, (chunk) => { this._post({ type: 'jiraStoriesChunk', chunk }); }, token);
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
        }
        catch (err) {
            this._post({ type: 'error', message: `Jira stories error: ${err.message || String(err)}` });
            this._post({ type: 'jiraStoriesComplete' });
        }
    }
    _csvEscape(value) {
        const v = value.replace(/\r?\n/g, ' ').replace(/"/g, '""');
        return `"${v}"`;
    }
    // ─── Webview HTML ─────────────────────────────────────────────────────────────
    _getWebviewContent() {
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
  .stack-change-banner .banner-actions { display: flex; gap: 8px; }
  .stack-change-banner .banner-apply {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; border-radius: 3px;
    padding: 4px 12px; cursor: pointer; font-size: 12px;
  }
  .stack-change-banner .banner-apply:hover { background: var(--vscode-button-hoverBackground); }
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

      <label class="option-item" style="margin-top:8px">
        <input type="checkbox" id="opt-phased"> Phased migration mode
      </label>

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
      <button class="tab" data-tab="chat">💬 Chat</button>
      <button class="tab" data-tab="previews">File Previews</button>
      <button class="tab" data-tab="debug">Debug</button>
      <button class="tab" data-tab="org">Org Dashboard</button>
      <button class="tab" data-tab="progress">Progress</button>
      <button class="tab" data-tab="files">Files</button>
      <button class="tab" data-tab="security">Security</button>
      <button class="tab" data-tab="raw">Raw</button>
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
          </div>
        </div>
        <div id="plan-rendered" style="flex:1; overflow:auto"></div>
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
          <div class="banner-actions">
            <button class="banner-apply" id="btn-apply-stack-change">Apply to plan</button>
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
      <pre id="export-content" style="flex:1;overflow:auto;white-space:pre-wrap;font-size:12px;background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:6px;padding:12px"></pre>
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

// ─── State ────────────────────────────────────────────────────────────────────
let planMarkdown = '';
let analysisData = null;
let isGenerating = false;
let lastRepoUrl   = '';

// ─── Element Refs ──────────────────────────────────────────────────────────────
const btnAnalyze       = document.getElementById('btn-analyze');
const btnGenerate      = document.getElementById('btn-generate');
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
const optPhased        = document.getElementById('opt-phased');
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
const planPatchIndicator   = document.getElementById('plan-patch-indicator');
const planPatchStatus      = document.getElementById('plan-patch-status');
const btnApplyStackChange  = document.getElementById('btn-apply-stack-change');
const btnDismissStackChange = document.getElementById('btn-dismiss-stack-change');

btnApplyStackChange.addEventListener('click', () => {
  stackChangeBanner.style.display = 'none';
  planPatchIndicator.style.display = 'flex';
  planPatchStatus.textContent = 'updating affected sections…';
  vscode.postMessage({ type: 'applyStackChange' });
});

btnDismissStackChange.addEventListener('click', () => {
  stackChangeBanner.style.display = 'none';
});

// ─── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
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
    phasedMode: optPhased.checked,
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
    exportContent.textContent = 'Generating…';
    vscode.postMessage({ type: 'exportPlan', exportFormat: fmt });
    return;
  }
  exportMarkdown = '';
  exportOutputWrap.style.display = 'flex';
  const labels = { checklist: '✅ Checklist', 'github-issue': '🐙 GitHub Issue', confluence: '📝 Confluence' };
  exportTitle.textContent = labels[fmt] || 'Export';
  exportContent.textContent = 'Generating…';
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
        planRendered.scrollTop = planRendered.scrollHeight;
      }
      break;

    case 'planComplete':
      stopGeneration(false);
      btnSaveMd.disabled = false;
      btnPreviews.disabled = false;
      btnJiraStories.disabled = false;
      enableChat();
      break;

    case 'planSaved':
      btnSaveMd.title = 'Saved!';
      setTimeout(() => { btnSaveMd.title = 'Save plan as .md'; }, 2000);
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
      if (msg.chunk === '') { previewsMarkdown = ''; previewsRendered.innerHTML = ''; }
      else {
        previewsMarkdown += msg.chunk;
        previewsRendered.innerHTML = parseMarkdown(previewsMarkdown);
        previewsRendered.scrollTop = previewsRendered.scrollHeight;
      }
      break;
    case 'previewComplete':
      previewsIndicator.style.display = 'none';
      break;

    // Debug (enhancement #3)
    case 'debugChunk':
      if (msg.chunk === '') { debugRendered.innerHTML = ''; }
      else { debugRendered.innerHTML = parseMarkdown(debugRendered.dataset.md = (debugRendered.dataset.md || '') + msg.chunk); }
      break;
    case 'debugComplete':
      btnDebug.disabled = false;
      btnStopDebug.style.display = 'none';
      break;

    // Export (enhancement #4)
    case 'exportReady':
      exportMarkdown = msg.exportContent || '';
      exportContent.textContent = exportMarkdown || 'Generating…';
      break;

    // Exec Summary (enhancement #5)
    case 'execSummaryChunk':
      if (msg.chunk === '') { exportMarkdown = ''; exportContent.textContent = ''; }
      else { exportMarkdown += msg.chunk; exportContent.textContent = exportMarkdown; }
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
      if (msg.chunk === '') { progressRendered.innerHTML = ''; progressRendered.dataset.md = ''; }
      else {
        progressRendered.dataset.md = (progressRendered.dataset.md || '') + msg.chunk;
        progressRendered.innerHTML = parseMarkdown(progressRendered.dataset.md);
      }
      break;
    case 'progressComplete':
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
        jiraOutput.innerHTML = parseMarkdown(jiraMarkdown);
        jiraOutput.scrollTop = jiraOutput.scrollHeight;
      }
      break;
    case 'jiraStoriesComplete':
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
        chatReplyBuf = '';
      } else {
        chatReplyBuf += msg.chunk;
        const bubble = document.getElementById('chat-pending-bubble');
        if (bubble) {
          bubble.innerHTML = parseMarkdown(chatReplyBuf) + \`<span class="cursor"></span>\`;
          chatThread.scrollTop = chatThread.scrollHeight;
        }
      }
      break;

    case 'chatComplete': {
      const bubble = document.getElementById('chat-pending-bubble');
      if (bubble) {
        bubble.removeAttribute('id');
        bubble.innerHTML = parseMarkdown(chatReplyBuf);
      }
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
      stackChangeBanner.style.display = 'flex';
      // Auto-scroll the chat tab so the banner is visible
      stackChangeBanner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      break;
    }

    // Plan is being rewritten section-by-section
    case 'planPatchChunk':
      if (msg.chunk === '') {
        planMarkdown = '';
        planRendered.innerHTML = '';
        planOutput.textContent = '';
      } else {
        planMarkdown += msg.chunk;
        planRendered.innerHTML = parseMarkdown(planMarkdown);
        planOutput.textContent = planMarkdown;
        planRendered.scrollTop = planRendered.scrollHeight;
      }
      break;

    // Plan patch complete — update status and switch to plan tab
    case 'planPatchComplete': {
      planPatchIndicator.style.display = 'none';
      if (msg.patchedPlan) {
        planMarkdown = msg.patchedPlan;
        planRendered.innerHTML = parseMarkdown(planMarkdown);
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
  if (cancelled && planMarkdown) {
    planMarkdown += '\\n\\n---\\n*Generation stopped.*';
    planRendered.innerHTML = parseMarkdown(planMarkdown);
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

// ─── Line-by-line Markdown Parser ────────────────────────────────────────────
function parseMarkdown(md) {
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
      while (i < lines.length && !/^\`\`\`/.test(lines[i])) { codeAcc.push(lines[i]); i++; }
      i++; // closing fence
      out.push(
        '<div class="code-wrap">' +
        '<div class="code-label">' + esc(lang) + '</div>' +
        '<pre><code>' + esc(codeAcc.join('\\n')) + '</code></pre>' +
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
  }

  flushList();
  return out.join('\\n');
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
exports.MigrationPanel = MigrationPanel;
MigrationPanel.viewType = 'migrationAssistant';
//# sourceMappingURL=migrationPanel.js.map