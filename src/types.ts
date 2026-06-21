// ─── Repo Analysis Types ────────────────────────────────────────────────────

export interface RepoInfo {
  owner: string;
  repo: string;
  hostname: string;        // e.g. "github.com" or "github.yourcompany.com"
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

export interface EnvVarUsage {
  name: string;          // e.g. "DATABASE_URL"
  files: string[];       // source files that reference this var
  defaultValue?: string; // inline default value if found (e.g. || '3000')
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

export interface ChunkSummary {
  chunkIndex: number;
  files: string[];    // paths of files in this chunk
  summary: string;    // LLM's structured analysis of those files
}

export interface RepoAnalysis {
  repoInfo: RepoInfo;
  detectedStack: DetectedStack;
  keyFiles: KeyFile[];
  fileTree: string[];
  totalFiles: number;
  redactionSummary: RedactionSummary;
  chunkSummaries?: ChunkSummary[];     // populated after full code analysis
  envVarInventory?: EnvVarUsage[];     // env vars discovered in source code
  dependencyUsage?: Record<string, { usageCount: number; files: string[] }>; // actual import usage per dep
  monorepoPackages?: string[];         // package names in monorepo (if applicable)
  subRepos?: string[];                 // top-level repo names when several repos are analyzed as one project
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
  | 'generateReport'
  | 'recommendStacks'
  | 'analyzeStackHealth'
  | 'aiDetectStack'
  | 'chat'
  | 'clearChat'
  | 'applyStackChange'
  | 'generateJiraStories'
  | 'retrySection'
  | 'generateArchitecture'
  | 'saveArchitecture'
  | 'generateSecurity'
  | 'saveSecurity'
  | 'browseLocalFolder'
  | 'analyzeLocal'
  | 'analyzeLocalMulti'
  | 'generateCorrection'
  | 'saveCorrection'
  | 'applyCorrection';

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
  chatMessage?: string;    // for chat
  jiraConfig?: JiraStoriesConfig; // for generateJiraStories
  regenerate?: boolean;    // for applyStackChange — true = regenerate full plan
  sectionHeading?: string; // for retrySection
  localPath?: string;      // for analyzeLocal — absolute path of a local repo folder
  localPaths?: string[];   // for analyzeLocalMulti — multiple repos analyzed as one project
  scopeRepo?: string;      // for generateCorrection — focus on one sub-repo, or undefined = whole project
}

/** A local folder that looks like a code repository. */
export interface LocalRepoCandidate {
  name: string;   // display name (folder name)
  path: string;   // absolute filesystem path
  marker: string; // what made it look like a repo, e.g. "package.json", ".git"
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

// ─── Stack Change Intent ────────────────────────────────────────────────────

/** Parsed intent when a chat message requests swapping one stack component */
export interface StackChangeIntent {
  /** The component being replaced, e.g. "Redux", "Jest", "MySQL" */
  fromComponent: string;
  /** The replacement, e.g. "Zustand", "Vitest", "PostgreSQL" */
  toComponent: string;
  /** Short reason the user supplied, or empty string */
  reason: string;
  /** Sections of the plan (heading text) that reference fromComponent */
  affectedSections: string[];
  /**
   * 'major' = primary framework / language / runtime change — the whole plan
   *           should be regenerated for coherence (e.g. Flask→FastAPI, React→Vue)
   * 'minor' = tool / library / CI / test-framework swap — patch affected
   *           sections only (e.g. Jest→Vitest, GitHub Actions→Jenkins)
   */
  scope: 'major' | 'minor';
}

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
  | 'reportError'
  | 'stackRecsChunk'
  | 'stackRecsComplete'
  | 'stackHealthChunk'
  | 'stackHealthComplete'
  | 'aiStackDetected'
  | 'chatChunk'
  | 'chatComplete'
  | 'chatCleared'
  | 'stackChangeDetected'
  | 'planPatchChunk'
  | 'planPatchComplete'
  | 'presetsReady'
  | 'presetsError'
  | 'modelsLoaded'
  | 'jiraStoriesChunk'
  | 'jiraStoriesComplete'
  | 'jiraStoriesCsv'
  | 'sectionProgress'
  | 'coherenceReady'
  | 'planDiff'
  | 'teamFormed'
  | 'agentMessageStart'
  | 'agentMessageChunk'
  | 'agentMessageEnd'
  | 'archTeamFormed'
  | 'archAgentMessageStart'
  | 'archAgentMessageChunk'
  | 'archAgentMessageEnd'
  | 'archChunk'
  | 'archSectionProgress'
  | 'archComplete'
  | 'archError'
  | 'architectureSaved'
  | 'secTeamFormed'
  | 'secAgentMessageStart'
  | 'secAgentMessageChunk'
  | 'secAgentMessageEnd'
  | 'secChunk'
  | 'secSectionProgress'
  | 'secComplete'
  | 'secError'
  | 'securitySaved'
  | 'localReposFound'
  | 'corrTeamFormed'
  | 'corrAgentMessageStart'
  | 'corrAgentMessageChunk'
  | 'corrAgentMessageEnd'
  | 'corrChunk'
  | 'corrSectionProgress'
  | 'corrComplete'
  | 'corrError'
  | 'correctionSaved'
  | 'applyProgress'
  | 'applyComplete'
  | 'applyError';

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
  aiStack?: AIDetectedStack;
  stackChangeIntent?: StackChangeIntent;   // for stackChangeDetected
  patchedPlan?: string;                    // for planPatchComplete — full updated plan
  presets?: MigrationPreset[];             // for presetsReady
  models?: string[];                        // for modelsLoaded
  jiraStories?: JiraStory[];                // for jiraStoriesComplete
  csvContent?: string;                      // for jiraStoriesCsv
  sectionIndex?: number;                    // for sectionProgress — 0-based
  sectionTotal?: number;                    // for sectionProgress — total count
  sectionHeading?: string;                  // for sectionProgress / retrySection
  failedSections?: string[];                // for planComplete — sections that failed
  coherenceReview?: string;                 // for coherenceReady — isolated from _lastPlan
  diffStats?: { added: number; removed: number; sections: string[] }; // for planDiff
  agents?: TeamAgent[];     // for teamFormed — the assembled migration team
  agentId?: string;         // for agentMessage* — which agent is speaking
  agentRole?: string;       // for agentMessageStart — display name
  agentEmoji?: string;      // for agentMessageStart — avatar
  agentPhase?: string;      // for agentMessageStart — 'analysis' | 'discussion' | 'synthesis'
  localRoot?: string;       // for localReposFound — the browsed parent folder
  localRepos?: LocalRepoCandidate[]; // for localReposFound — detected repo folders
  appliedFiles?: string[];  // for applyComplete — files that were rewritten
  backupPaths?: string[];   // for applyComplete — where backups were saved
  canApply?: boolean;       // for analysisComplete — whether code-apply is available (local only)
}

// ─── Agent Team (multi-agent plan generation) ─────────────────────────────────

/** A specialist agent on the simulated migration team. */
export interface TeamAgent {
  id: string;        // stable id used to route streamed messages, e.g. "frontend"
  role: string;      // display name, e.g. "React Specialist"
  emoji: string;     // single emoji avatar
  focus: string;     // one-line description of the agent's domain
  files: string[];   // repo files this agent "owns" (assigned from the file tree)
}

// ─── AI Stack Detection ───────────────────────────────────────────────────────

export interface AIDetectedStack {
  primaryLanguage: string;
  framework: string;
  runtime: string;
  buildTool: string;
  packageManager: string;
  currentVersion: string;
  containerized: boolean;
  ciSystem: string;
  databases: string[];
  testingFrameworks: string[];
  insights: string; // extra observations that don't fit structured fields
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
  analysis?: RepoAnalysis; // stored so history loads can restore context-dependent features
}

// ─── Migration Plan Types ─────────────────────────────────────────────────────

export interface MigrationRequest {
  analysis: RepoAnalysis;
  targetStack: string;
  options: AnalysisOptions;
}

// ─── Migration Preset Types ───────────────────────────────────────────────────

export interface MigrationPreset {
  id: string;
  title: string;
  targetStack: string;
  effort: 'Low' | 'Medium' | 'High' | 'Very High';
  rationale: string;
  pros: string[];
  cons: string[];
}

// ─── Chat Types ───────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

// ─── Jira Story Generation Types ──────────────────────────────────────────────

export interface JiraStory {
  epicKey: string;         // e.g. "MIGRATION-E1"
  epicName: string;        // e.g. "Foundation Setup"
  storyId: string;         // e.g. "MIGRATION-101"
  summary: string;         // Jira summary field
  description: string;     // detailed description
  storyPoints: number;     // Fibonacci: 1,2,3,5,8,13
  priority: 'Critical' | 'High' | 'Medium' | 'Low';
  sprint: string;          // e.g. "Sprint 1 — Foundation"
  sprintNumber: number;    // 1-based
  labels: string[];        // e.g. ["migration", "backend"]
  estimatedDays: number;   // calendar days
  component: string;       // area of the codebase
  acceptanceCriteria: string;
  suggestions: string;     // AI tips / gotchas
}

export interface JiraStoriesConfig {
  teamSize: number;
  sprintWeeks: number;     // typically 2
  roles: string[];         // e.g. ["Senior Dev", "Junior Dev", "QA", "DevOps"]
}

export interface JiraStoriesResult {
  stories: JiraStory[];
  totalPoints: number;
  estimatedSprints: number;
  summary: string;         // markdown overview
}
