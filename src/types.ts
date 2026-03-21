// ─── Repo Analysis Types ────────────────────────────────────────────────────

export interface RepoInfo {
  owner: string;
  repo: string;
  defaultBranch: string;
  description: string;
  language: string;
  stars: number;
  size: number; // KB
}

export interface KeyFile {
  path: string;
  content: string;       // already redacted
  type: 'package-manager' | 'build-tool' | 'config' | 'source' | 'docker' | 'ci' | 'readme';
  redactedCount: number; // how many secrets were replaced in this file
}

export interface RedactionSummary {
  totalRedactions: number;
  filesWithSecrets: string[];  // file paths that had at least one redaction
  skippedFiles: string[];      // sensitive files that were not fetched at all
}

export interface DetectedStack {
  primaryLanguage: string;
  framework: string;
  runtime: string;
  buildTool: string;
  packageManager: string;
  containerized: boolean;
  ciSystem: string;
  databases: string[];
  testingFrameworks: string[];
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  currentVersion: string; // e.g. Node 14, Java 8, Python 3.8
}

export interface RepoAnalysis {
  repoInfo: RepoInfo;
  detectedStack: DetectedStack;
  keyFiles: KeyFile[];
  fileTree: string[];
  totalFiles: number;
  redactionSummary: RedactionSummary;
}

// ─── Webview <-> Extension Message Types ─────────────────────────────────────

export type WebviewMessageType =
  | 'ready'
  | 'analyze'
  | 'generatePlan'
  | 'stopGeneration'
  | 'openSettings'
  | 'saveToken'
  | 'validateToken'
  | 'savePlan'
  | 'changeModel'
  | 'loadFromHistory'
  | 'clearHistory'
  | 'removeFromHistory'
  | 'addToQueue'
  | 'analyzeQueue'
  | 'debugError'
  | 'exportPlan'
  | 'analyzeOrg'
  | 'checkProgress'
  | 'generateFilePreviews'
  | 'getExecSummary'
  | 'generateReport';

export interface WebviewMessage {
  type: WebviewMessageType;
  repoUrl?: string;
  githubToken?: string;
  targetStack?: string;
  options?: AnalysisOptions;
  plan?: string;
  model?: string;
  historyId?: string;
  queueUrls?: string[];
  errorMessage?: string;   // for debugError
  exportFormat?: ExportFormat; // for exportPlan
  orgUrl?: string;         // for analyzeOrg
  branch?: string;         // for checkProgress
  reportFormat?: 'word' | 'html'; // for generateReport
}

export interface AnalysisOptions {
  includeTestMigration: boolean;
  includeCiMigration: boolean;
  includeDockerMigration: boolean;
  detailLevel: 'summary' | 'detailed' | 'file-by-file';
  phasedMode: boolean;
  scope: 'full' | 'dependencies' | 'api' | 'database' | 'config' | 'docker' | 'ci';
}

// ─── Org Dashboard Types ──────────────────────────────────────────────────────

export interface OrgRepo {
  name: string;
  fullName: string;
  description: string;
  language: string;
  stars: number;
  size: number;
  defaultBranch: string;
  updatedAt: string;
  detectedStack?: string;
  complexity?: 'Low' | 'Medium' | 'High' | 'Unknown';
}

export interface OrgDashboard {
  org: string;
  hostname: string;
  totalRepos: number;
  repos: OrgRepo[];
}

// ─── Progress Check Types ─────────────────────────────────────────────────────

export interface BranchDiff {
  baseBranch: string;
  compareBranch: string;
  changedFiles: string[];
  additions: number;
  deletions: number;
  diffSample: string; // truncated diff for Copilot
}

// ─── Export Format Types ──────────────────────────────────────────────────────

export type ExportFormat = 'checklist' | 'github-issue' | 'exec-summary' | 'confluence';

export type ExtensionMessageType =
  | 'progress'
  | 'analysisComplete'
  | 'planChunk'
  | 'planComplete'
  | 'error'
  | 'stopped'
  | 'settingsLoaded'
  | 'tokenSaved'
  | 'tokenValidation'
  | 'planSaved'
  | 'historyLoaded'
  | 'cacheHit'
  | 'queueProgress'
  | 'debugChunk'
  | 'debugComplete'
  | 'exportReady'
  | 'orgDashboard'
  | 'progressChunk'
  | 'progressComplete'
  | 'previewChunk'
  | 'previewComplete'
  | 'execSummaryChunk'
  | 'execSummaryComplete'
  | 'reportReady'
  | 'reportError';

export interface ExtensionMessage {
  type: ExtensionMessageType;
  message?: string;
  step?: number;
  totalSteps?: number;
  analysis?: RepoAnalysis;
  chunk?: string;
  settings?: { githubToken: string; copilotModel: string };
  isValid?: boolean;
  username?: string;
  entries?: HistoryEntry[];
  cachedAt?: number;
  queueIndex?: number;
  queueTotal?: number;
  queueRepo?: string;
  exportContent?: string;
  exportFormat?: ExportFormat;
  dashboard?: OrgDashboard;
}

// ─── Cache & History Types ────────────────────────────────────────────────────

export interface CachedAnalysis {
  analysis: RepoAnalysis;
  repoUrl: string;
  timestamp: number;
}

export interface HistoryEntry {
  id: string;
  repoUrl: string;
  owner: string;
  repo: string;
  targetStack: string;
  timestamp: number;
  plan: string; // full markdown
}

// ─── Migration Plan Types ─────────────────────────────────────────────────────

export interface MigrationRequest {
  analysis: RepoAnalysis;
  targetStack: string;
  options: AnalysisOptions;
}
