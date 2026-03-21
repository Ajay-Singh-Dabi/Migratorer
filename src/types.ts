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
  content: string;
  type: 'package-manager' | 'build-tool' | 'config' | 'source' | 'docker' | 'ci' | 'readme';
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
}

// ─── Webview <-> Extension Message Types ─────────────────────────────────────

export type WebviewMessageType =
  | 'ready'
  | 'analyze'
  | 'generatePlan'
  | 'stopGeneration'
  | 'openSettings';

export interface WebviewMessage {
  type: WebviewMessageType;
  repoUrl?: string;
  githubToken?: string;
  targetStack?: string;
  options?: AnalysisOptions;
}

export interface AnalysisOptions {
  includeTestMigration: boolean;
  includeCiMigration: boolean;
  includeDockerMigration: boolean;
  detailLevel: 'summary' | 'detailed' | 'file-by-file';
}

export type ExtensionMessageType =
  | 'progress'
  | 'analysisComplete'
  | 'planChunk'
  | 'planComplete'
  | 'error'
  | 'stopped'
  | 'settingsLoaded';

export interface ExtensionMessage {
  type: ExtensionMessageType;
  message?: string;
  step?: number;
  totalSteps?: number;
  analysis?: RepoAnalysis;
  chunk?: string;
  settings?: { githubToken: string; copilotModel: string };
}

// ─── Migration Plan Types ─────────────────────────────────────────────────────

export interface MigrationRequest {
  analysis: RepoAnalysis;
  targetStack: string;
  options: AnalysisOptions;
}
