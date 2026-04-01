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
exports.analyzeFilesInChunks = analyzeFilesInChunks;
exports.streamMigrationPlan = streamMigrationPlan;
exports.getAvailableModels = getAvailableModels;
exports.streamStackRecommendations = streamStackRecommendations;
exports.detectStackWithAI = detectStackWithAI;
exports.streamStackHealthAnalysis = streamStackHealthAnalysis;
exports.streamDebugHelp = streamDebugHelp;
exports.streamExecSummary = streamExecSummary;
exports.streamFilePreviews = streamFilePreviews;
exports.streamProgressCheck = streamProgressCheck;
exports.streamExportFormat = streamExportFormat;
exports.streamDetailedReport = streamDetailedReport;
exports.streamJiraStories = streamJiraStories;
exports.generatePresets = generatePresets;
exports.streamChatReply = streamChatReply;
exports.detectStackChangeIntent = detectStackChangeIntent;
exports.streamPlanPatch = streamPlanPatch;
const vscode = __importStar(require("vscode"));
// ─── File Tree Path Filter ────────────────────────────────────────────────────
// Strip paths that could reveal sensitive infrastructure or credentials
// even if only the path name itself is sent (not the content)
const SENSITIVE_PATH_PATTERNS = [
    /\.env(\..+)?$/i,
    /secret/i,
    /credential/i,
    /private[-_]?key/i,
    /\.pem$/i,
    /\.key$/i,
    /\.pfx$/i,
    /\.p12$/i,
    /\.jks$/i,
    /kubeconfig/i,
    /tfvars$/i,
    /vault/i,
    /\.htpasswd$/i,
];
function isSensitivePath(filePath) {
    return SENSITIVE_PATH_PATTERNS.some((p) => p.test(filePath));
}
function filterFileTree(fileTree) {
    const safe = fileTree.filter((f) => !isSensitivePath(f));
    return { safe, removed: fileTree.length - safe.length };
}
// ─── Model Selection ──────────────────────────────────────────────────────────
async function selectModel() {
    const config = vscode.workspace.getConfiguration('migrationAssistant');
    const preferredFamily = config.get('copilotModel', 'gpt-4o');
    // Try preferred model first, then fall back
    const families = [preferredFamily, 'gpt-4o', 'gpt-4', 'gpt-3.5-turbo'];
    for (const family of families) {
        const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family });
        if (models.length > 0) {
            return models[0];
        }
    }
    // Last resort: any available model
    const all = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (all.length > 0) {
        return all[0];
    }
    throw new Error('No GitHub Copilot models are available.\n' +
        'Please ensure:\n' +
        '1. GitHub Copilot extension is installed and enabled\n' +
        '2. You are signed in to GitHub\n' +
        '3. Your Copilot subscription is active');
}
// ─── Private Package Masking ──────────────────────────────────────────────────
function maskPrivatePackages(deps) {
    const config = vscode.workspace.getConfiguration('migrationAssistant');
    if (!config.get('maskOrgPackages', true)) {
        return deps;
    }
    const masked = {};
    for (const [name, version] of Object.entries(deps)) {
        // Mask scoped packages that are not well-known public orgs
        const PUBLIC_ORGS = new Set(['@types', '@babel', '@jest', '@testing-library', '@angular', '@vue', '@react', '@nestjs', '@prisma', '@aws-sdk', '@google-cloud']);
        if (name.startsWith('@')) {
            const org = name.split('/')[0];
            masked[PUBLIC_ORGS.has(org) ? name : `${org}/[masked-package]`] = version;
        }
        else {
            masked[name] = version;
        }
    }
    return masked;
}
// ─── Prompt Builder ───────────────────────────────────────────────────────────
// ─── Context builder (shared across all section prompts) ──────────────────────
function buildContext(analysis, targetStack) {
    const { repoInfo, detectedStack, keyFiles } = analysis;
    const { safe: safeFileTree } = filterFileTree(analysis.fileTree);
    const maskedDeps = maskPrivatePackages(detectedStack.dependencies);
    const maskedDevDeps = maskPrivatePackages(detectedStack.devDependencies);
    const depsList = Object.entries(maskedDeps).slice(0, 20)
        .map(([k, v]) => `  ${k}: ${v}`).join('\n');
    const devDepsList = Object.entries(maskedDevDeps).slice(0, 12)
        .map(([k, v]) => `  ${k}: ${v}`).join('\n');
    // Short file snippets — include all fetched files so the AI sees the full sample
    const fileSnippets = keyFiles.slice(0, 25)
        .map(f => {
        const safe = f.content.replace(/\[REDACTED:[^\]]*\]/g, '""').slice(0, 400);
        return `${f.path}:\n${safe}`;
    }).join('\n\n---\n\n');
    // Show up to 300 paths from the full file tree, grouped by top-level folder
    // so the AI understands the complete project structure.
    const MAX_TREE = 300;
    const treeToShow = safeFileTree.slice(0, MAX_TREE);
    const byFolder = new Map();
    for (const p of treeToShow) {
        const slash = p.indexOf('/');
        const folder = slash >= 0 ? p.slice(0, slash) : '(root)';
        if (!byFolder.has(folder)) {
            byFolder.set(folder, []);
        }
        byFolder.get(folder).push(p);
    }
    const fileTreeSection = Array.from(byFolder.entries())
        .map(([folder, files]) => `${folder}/\n${files.map(f => `  ${f}`).join('\n')}`)
        .join('\n');
    const treeTruncNote = safeFileTree.length > MAX_TREE
        ? `\n... and ${safeFileTree.length - MAX_TREE} more files (total: ${analysis.totalFiles})`
        : '';
    // Folder-level summary: quick overview of module structure by file count
    const folderSummary = Array.from(byFolder.entries())
        .map(([folder, files]) => `  ${folder}/  (${files.length} files)`)
        .join('\n');
    return `Project: ${repoInfo.owner}/${repoInfo.repo}
Language: ${repoInfo.language} | Files: ${analysis.totalFiles} | Size: ${repoInfo.size} KB
Migration target: ${targetStack}

Current stack:
- Language: ${detectedStack.primaryLanguage} ${detectedStack.currentVersion}
- Framework: ${detectedStack.framework}
- Runtime: ${detectedStack.runtime}
- Build tool: ${detectedStack.buildTool}
- Package manager: ${detectedStack.packageManager}
- Containers: ${detectedStack.containerized ? 'Yes (Docker)' : 'No'}
- CI/CD: ${detectedStack.ciSystem || 'None'}
- Databases: ${detectedStack.databases.join(', ') || 'None'}
- Tests: ${detectedStack.testingFrameworks.join(', ') || 'None'}

Production dependencies:
${depsList || '  (none)'}

Dev dependencies:
${devDepsList || '  (none)'}

Module structure (top-level folders):
${folderSummary}

Key files (short excerpt):
${fileSnippets || '(none)'}

Full project file tree (all folders and files):
${fileTreeSection}${treeTruncNote}

IMPORTANT: Any file path you mention in your output MUST come from the file tree above. Do not invent file names.

${analysis.chunkSummaries?.length
        ? `─── Full Codebase Analysis (${analysis.keyFiles.filter(f => f.type === 'source').length} source files analyzed in ${analysis.chunkSummaries.length} groups) ───

${analysis.chunkSummaries.map((cs) => `Group ${cs.chunkIndex + 1} — files: ${cs.files.join(', ')}\n${cs.summary}`).join('\n\n---\n\n')}`
        : '(Run "Generate Plan" to trigger full codebase analysis)'}`;
}
function buildSections(analysis, targetStack, options) {
    const { detectedStack } = analysis;
    const { safe: safeTree } = filterFileTree(analysis.fileTree);
    // Compact path list injected directly into file-heavy sections so the model
    // references real files rather than inventing placeholders.
    const allPaths = safeTree.slice(0, 400).join('\n');
    return [
        // ── Section 1: Architecture Overview ─────────────────────────────────────
        {
            heading: '## 1. Current Architecture Overview',
            ask: `Using ONLY the file tree and key file excerpts provided above, describe the current project architecture. Do not guess — only describe what is visible in the context.

### 1.1 Module Structure
For each top-level folder in the module structure above, write one line: folder name, what it contains, its role in the application.

### 1.2 Entry Points
List the main entry point file(s) by exact path from the file tree. Explain what each one does.

### 1.3 Application Layers
Identify: UI layer, API/route layer, service/business logic layer, data/persistence layer, config layer. For each, list the actual folder and representative file paths from the tree.

### 1.4 Key Files for Migration
List the 15–20 most important files that will need to change during migration. Use exact paths from the file tree. For each: path, current purpose, expected change type (Rewrite / Config update / Remove / Keep).

### 1.5 External Integration Inventory
Scan the file tree and key file excerpts for all external integration points this codebase depends on: webhooks, OAuth/SSO callbacks, third-party SDKs, payment processors, email providers, analytics, feature-flag services, secret managers, CDN/object-storage clients, monitoring agents. For each integration found:
- **Name:** [service name]
- **Type:** [webhook / OAuth callback / SDK / API client / agent]
- **Where declared:** [exact file path(s) from the tree]
- **Migration impact:** [URL/key change required / SDK replacement / No change]

If none are detected, state "No external integrations detected in the visible file tree."`,
        },
        // ── Section 2: Feasibility ────────────────────────────────────────────────
        {
            heading: '## 2. Migration Feasibility Assessment',
            ask: `Based on the architecture overview and file tree, write a Migration Feasibility Assessment:

- **Complexity rating** (Low / Medium / High / Very High) — justify with actual file count (${analysis.totalFiles} total), folder count, key dependencies, and detected framework version

- **Test coverage caveat:** Identify whether test files exist in the file tree. Estimate existing test coverage (High ≥70% / Medium 30–70% / Low <30% / Unknown — no test files found). State the migration risk multiplier: low coverage means regressions may go undetected through the migration.

- **Effort table:**

| Team Size | Estimate | Key Assumptions |
|-----------|----------|-----------------|
| Solo developer | ? weeks | ... |
| Small team (2–3) | ? weeks | ... |
| Experienced contractor | ? weeks | ... |

- **Risk register** (minimum 10 risks — include at least one risk per category: data, integration, test coverage, deployment, security, rollback):

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|

- **Prerequisites** before starting (specific commands, environment checks, and go/no-go criteria)`,
        },
        // ── Section 3: Breaking Changes ───────────────────────────────────────────
        {
            heading: '## 3. Breaking Changes & Gotchas',
            ask: `List every breaking change between ${detectedStack.framework} and ${targetStack} that will affect files in this project.

For each breaking change:
### Breaking Change: [Name]
- **What breaks:** [which specific file(s) from the file tree are affected — use exact paths]
- **Why:** [technical root cause]
- **Fix:** [exact code change with before/after]
- **Find it:** \`[grep/search command]\`

Write at least 8 breaking changes. Reference real file paths from the tree.`,
        },
        // ── Section 4: Stack Mapping ──────────────────────────────────────────────
        {
            heading: '## 4. Current Stack → Target Stack Mapping',
            ask: `Write the complete technology mapping table for migrating to ${targetStack}.

Every row MUST start and end with |:

| Category | Current | Version | → | Target | Version | Change Type |
|----------|---------|---------|---|--------|---------|-------------|

Fill every cell with real values from the detected stack above. Cover all rows: Runtime, Framework, Build Tool, Package Manager, State Management, Routing, Styling, Testing, Linting, Formatting, CI/CD, Containerisation, Database/ORM, Auth.

Change Types: Direct upgrade / Full replacement / New addition / Remove / Keep as-is

After the table, explain the 3 most significant changes and the technical rationale.`,
        },
        // ── Section 5: Step-by-step ───────────────────────────────────────────────
        {
            heading: '## 5. Step-by-Step Migration Guide',
            ask: `Write a detailed numbered migration guide from ${detectedStack.framework} to ${targetStack}.

First, scan the file tree and categorise all files that need to change:

<file-tree>
${allPaths}
</file-tree>

Group them:
- **Config files to rewrite:** (exact paths)
- **Source files to update:** (exact paths, grouped by folder)
- **Test files to migrate:** (exact paths)
- **Files to delete:** (exact paths)
- **New files to create:** (path + purpose)

Then write the step-by-step guide. For each step:

### Step N: [Action title]
**Why:** [technical reason — reference a breaking change from Section 3 if relevant]
**Files:** [exact paths from the file tree above]
\`\`\`bash
# exact command
\`\`\`
**Before:**
\`\`\`
[current code pattern]
\`\`\`
**After:**
\`\`\`
[new code pattern]
\`\`\`
**Verify:** \`[command]\` → [expected output]
**Rollback:** \`[exact command to undo this step — e.g. git revert, npm install old-package, restore backup, or git checkout -- <file>]\`

Write at least 12 steps covering: dependencies → config → routes → services → models → tests → CI/CD → build → deploy. Every file path must exist in the file tree above.`,
        },
        // ── Section 6: Dependencies ───────────────────────────────────────────────
        {
            heading: '## 6. Dependency Migration',
            ask: `Write the complete dependency migration guide. Use markdown pipe tables (every row starts and ends with |).

### Remove
| Package | Current Version | Reason | Replacement |
|---------|-----------------|--------|-------------|
(one row per dependency from the detected stack — no "etc.")

### Add
| Package | Version | Purpose | Install Command |
|---------|---------|---------|-----------------|

### Upgrade
| Package | From | To | Breaking Changes | Notes |
|---------|------|----|-----------------|-------|

End with: single install command to apply all changes, and lockfile strategy for the new stack.`,
        },
        // ── Section 7: Code Pattern Changes ──────────────────────────────────────
        {
            heading: '## 7. Code Pattern Changes',
            ask: `For each recurring code pattern that must change in this migration:

### Pattern: [Name]
**Where it appears:** [list actual file paths from the file tree that contain this pattern]
**Problem:** [why the old pattern doesn't work in ${targetStack}]
**Before** (${detectedStack.primaryLanguage}):
\`\`\`
[current code]
\`\`\`
**After** (${targetStack}):
\`\`\`
[new code]
\`\`\`
**How to find all occurrences:** \`[grep command]\`

Cover at least 8 patterns. Only mention file paths that exist in the file tree.`,
        },
        // ── Section 8: Data Migration Strategy (NEW) ─────────────────────────────
        {
            heading: '## 8. Data Migration Strategy',
            ask: `Write a production-safe data and schema migration strategy for this migration from ${detectedStack.framework} to ${targetStack}.

### 8.1 Schema Change Inventory
Scan the file tree for migration files, ORM model definitions, and schema files (look for paths containing: migrations/, models/, schema, prisma, sequelize, alembic, typeorm, flyway, liquibase, db/). List each schema change that the migration will require, with the relevant file paths.

If no schema files are detected, state "No ORM/migration files found — add schema change inventory manually."

### 8.2 Expand / Contract Pattern (Zero-Downtime)
For each breaking schema change, describe the 3-phase expand/contract approach:
- **Expand phase:** Add new columns/tables without removing old ones. Both old and new code work.
- **Migrate phase:** Backfill existing rows. Provide the exact SQL or ORM migration script.
- **Contract phase:** Remove old columns/tables only after the new stack is fully deployed and verified.

Provide real SQL or migration-framework commands for each phase.

### 8.3 Migration Script Standards
- Naming convention for migration files (e.g. \`V{timestamp}__{description}.sql\`)
- How to version and track applied migrations
- How to run migrations in CI vs production (exact commands)
- How to verify data integrity after each migration: \`[verification query or script]\`

### 8.4 Rollback Strategy
For each migration step above, provide the exact rollback script or command (e.g. \`ALTER TABLE ... DROP COLUMN ...\`, ORM \`down()\` method, or snapshot restore). State any irreversible steps (e.g. data-type narrowing, column drops) and what backup must be taken before running them.

### 8.5 Data Integrity Checks
Provide at least 3 SQL/ORM queries to run after migration to verify data completeness and correctness (e.g. row count comparison, null checks on required fields, foreign key constraint validation).`,
        },
        // ── Section 9: Test Migration ─────────────────────────────────────────────
        {
            heading: '## 9. Test Migration',
            ask: `Write the test migration plan.

- Current test files (list paths from the file tree matching test/spec patterns)
- Estimated current coverage level (based on ratio of test files to source files in the tree)
- Framework mapping: ${detectedStack.testingFrameworks.join(', ') || 'none detected'} → ${targetStack} testing tools
- Before/after example for a unit test and an integration test
- Migration command sequence
- Coverage target (minimum 70% recommended for a safe migration) and measurement command
- If coverage is currently low: add a "write missing tests before migration" task to Phase 1 of the schedule`,
            condition: options.includeTestMigration,
        },
        // ── Section 10: CI/CD ─────────────────────────────────────────────────────
        {
            heading: '## 10. CI/CD Pipeline Update',
            ask: `Write the updated CI/CD pipeline for ${targetStack} (based on ${detectedStack.ciSystem || 'GitHub Actions'}).

Provide a complete, ready-to-commit YAML covering: install, lint, type-check, test, build, deploy.

\`\`\`yaml
# complete pipeline
\`\`\`

List every required environment variable, its purpose, and where to store it.

Add a **migration safety gate** job that runs before deploy: it must run all database migrations in a dry-run or against a staging environment and fail the pipeline if any migration errors. Show the YAML job definition.`,
            condition: options.includeCiMigration,
        },
        // ── Section 11: Docker / Container Updates ────────────────────────────────
        {
            heading: '## 11. Docker / Container Updates',
            ask: `Analyse the current Dockerfile and docker-compose files visible in the file tree. Provide the complete updated versions for ${targetStack}:

\`\`\`dockerfile
# updated Dockerfile — comment every changed layer
\`\`\`

\`\`\`yaml
# updated docker-compose.yml (if applicable)
\`\`\``,
            condition: options.includeDockerMigration && detectedStack.containerized,
        },
        // ── Section 12: Performance & Security Improvements ───────────────────────
        {
            heading: '## 12. Performance & Security Improvements',
            ask: `For each improvement ${targetStack} brings over ${detectedStack.framework}:

### [Improvement title]
- **Current limitation:** [what is slow or insecure now, with specific version or pattern]
- **Root cause:** [why the current stack has this]
- **Fix in ${targetStack}:** [specific mechanism, config, or API]
- **Expected gain:** [quantified estimate]
- **Verify:** [benchmark or security scan command]

Write at least 4 performance and 4 security improvements. Reference config files from the file tree where applicable.`,
        },
        // ── Section 13: Traffic Routing & Cutover Strategy (NEW) ─────────────────
        {
            heading: '## 13. Traffic Routing & Cutover Strategy',
            ask: `Write a production-safe traffic routing and cutover strategy for the live switch from ${detectedStack.framework} to ${targetStack}. A "big-bang" cutover is NOT acceptable for production systems — describe a gradual, verifiable approach.

### 13.1 Recommended Cutover Pattern
Choose the most appropriate pattern for this codebase and justify why:
- **Strangler Fig** — incrementally replace routes/modules behind a router/proxy until old service is fully replaced
- **Blue/Green Deployment** — run both stacks simultaneously, flip DNS/load-balancer once new stack is verified
- **Canary Release** — route a % of real traffic to the new stack, monitor, then increase gradually

Provide the specific infrastructure changes (load balancer config, reverse proxy rules, feature-flag config) needed to implement the chosen pattern.

### 13.2 Traffic Shift Schedule
Define the incremental steps:

| Stage | Traffic to New Stack | Duration | Success Criteria | Rollback Trigger |
|-------|--------------------|----------|------------------|-----------------|
| Canary | 5% | 30 min | Error rate < 0.1%, P95 < baseline + 20% | Any error rate spike |
| Ramp | 25% | 1 hour | ... | ... |
| Half | 50% | 1 hour | ... | ... |
| Full | 100% | — | All checks green | Immediate rollback |

### 13.3 Feature Flag Integration (if applicable)
If the codebase has a feature-flag service or any conditional branching tied to environment variables (scan the file tree and key files for feature flag patterns), show how to use flags to route at the application level without infrastructure changes.

### 13.4 DNS / Load Balancer Cutover Commands
Provide exact CLI commands for the cutover (e.g. AWS CLI, kubectl, nginx config reload, DNS TTL change). Include pre-cutover TTL reduction and post-cutover verification.

### 13.5 Rollback Plan
**Trigger criteria:** List the exact metrics that trigger an immediate rollback (e.g. HTTP 5xx rate > 1%, P95 latency > Xms, X failed health checks).
**Rollback steps:**
1. [exact command] — expected time: Xs
2. [exact command] — expected time: Xs
...
**Recovery time objective (RTO):** [estimated time to full rollback]`,
        },
        // ── Section 14: Observability During Migration (NEW) ─────────────────────
        {
            heading: '## 14. Observability During Migration',
            ask: `Write an observability and monitoring plan specifically for the migration period — not for steady-state production, but for the window while the new stack is being deployed and traffic is being shifted.

### 14.1 Key Metrics to Monitor During Cutover
For each metric below, provide: what to watch, normal baseline, alert threshold, and what the anomaly indicates:

| Metric | Baseline | Alert Threshold | What it indicates |
|--------|---------|-----------------|-------------------|
| HTTP 5xx error rate | | | |
| HTTP 4xx error rate | | | |
| P50 response time | | | |
| P95 response time | | | |
| P99 response time | | | |
| Database connection pool utilisation | | | |
| Database query error rate | | | |
| Memory usage (new stack process) | | | |
| CPU usage (new stack process) | | | |
| Failed authentication / 401 rate | | | |
| Queue depth (if async workers present) | | | |

Fill in realistic threshold values based on the detected stack and typical production behaviour.

### 14.2 Structured Logging Requirements
The new stack MUST emit structured (JSON) logs with at minimum these fields during migration:
- \`migration_phase\` (phase name from the phased schedule)
- \`stack_version\` (old | new | both)
- \`request_id\`
- \`user_id\` (or session_id)
- \`duration_ms\`
- \`error\` (if present)

Show exactly where to add this logging in ${targetStack} (code location from the file tree, with before/after snippet).

### 14.3 Dark Launch / Shadow Mode (if applicable)
If the codebase handles data writes, describe a shadow-mode setup where the new stack receives real requests in parallel but its writes are discarded, allowing output comparison without affecting production data.

### 14.4 Alerting Rules
Write at least 5 specific alerting rules (in pseudo-code or as your monitoring tool's query format) that should be active during the cutover window:
1. Rule name: [name] — Query: [query] — Severity: [critical/warning] — Action: [page on-call / auto-rollback]
...

### 14.5 Migration Dashboard
List the 8 most important dashboard panels to have open in your monitoring tool during the cutover, in priority order. For each: panel name, what it shows, why it matters during migration.

### 14.6 Post-Cutover Soak Period
After reaching 100% traffic on the new stack, define the minimum soak period before considering the migration complete, and the criteria for closing the migration incident/change ticket.`,
        },
        // ── Section 15: Post-Migration Checklist ─────────────────────────────────
        {
            heading: '## 15. Post-Migration Checklist',
            ask: `Write the post-migration verification checklist. Every item must include a concrete verification command and an expected outcome.

Format each item as:
- [ ] **[Item]** — \`[command]\` → [expected output]

Cover at least 25 items across these categories:
- **Code correctness:** all key source files updated, no old import patterns remain, no dead code referencing old framework
- **Test quality:** test suite passes, coverage ≥ target, no skipped tests
- **Build & artefacts:** production build succeeds, bundle size within budget, no debug flags
- **Dependencies:** no old packages in node_modules / site-packages, lockfile committed, no duplicate package versions
- **Data integrity:** migration scripts applied, row counts match, no null violations, foreign keys valid
- **Security:** dependency audit passes, secrets not hardcoded, HTTPS enforced, auth flows tested, OWASP headers present
- **Performance:** P95 latency at or below baseline, no N+1 queries, cache warm
- **Infrastructure:** CI pipeline green, Docker image builds and starts, health endpoint returns 200, env vars configured in all environments
- **Observability:** structured logs flowing, alerts configured, dashboards updated
- **Documentation:** README updated, API docs reflect new stack, runbook updated, on-call handover done`,
        },
        // ── Section 16: Phased Migration Schedule (always generated) ─────────────
        {
            heading: '## 16. Phased Migration Schedule',
            ask: `Break this migration into 3 phases based on the actual file inventory. Every phase must be independently deployable to production — no "big-bang" all-at-once approach.

### Phase 1 — Foundation (ships to production independently, zero breaking changes)
**Goal:** Set up the new toolchain alongside the old stack. No user-facing changes.
**Duration:** [estimate]
**Go/No-Go criteria:** [what must be true before starting Phase 2]

Numbered task list with exact file paths, terminal commands, and verification steps. Include:
- Dependency installs (exact command)
- Toolchain config files (exact paths to create/modify)
- CI pipeline update to run both old and new linters/type-checkers in parallel
- Baseline test suite run on the new stack (even if tests fail — collect the failure list)
- Write any missing tests to reach minimum coverage threshold

### Phase 2 — Core Migration (feature branch, breaking changes)
**Goal:** Migrate all application logic. Traffic still 100% on old stack.
**Duration:** [estimate]
**Go/No-Go criteria:** [what must be true before starting Phase 3 — minimum: test suite passes, staging deployment verified]

Numbered task list referencing the breaking changes from Section 3 and steps from Section 5. Include:
- Order of file migrations (reference exact paths from Section 5 file inventory)
- Database schema expand phase (reference Section 8)
- Integration point updates (reference Section 1.5 external integration inventory)
- End-to-end test run on staging

### Phase 3 — Hardening & Cutover (production traffic shift)
**Goal:** Migrate production traffic using the cutover strategy from Section 13.
**Duration:** [estimate]
**Go/No-Go criteria:** [all Phase 2 criteria met + performance baseline on staging verified + rollback plan rehearsed]

Numbered task list including:
- Contract phase of database migration (reference Section 8)
- Deploy new stack to production in parallel (not live yet)
- Execute traffic shift schedule from Section 13.2 step by step
- Monitor using Section 14 dashboard during each traffic shift increment
- Run post-migration checklist from Section 15 at 100% traffic
- Soak period (reference Section 14.6)
- Retire old stack (exact commands to decommission: remove containers, revoke old credentials, archive repo branch)`,
        },
    ].filter(s => s.condition !== false);
}
// ─── Token-aware streaming ─────────────────────────────────────────────────────
/**
 * Count tokens for a prompt string using the model's own tokenizer.
 * Falls back to a character-based estimate if counting fails.
 */
async function countTokens(model, text) {
    try {
        return await model.countTokens(vscode.LanguageModelChatMessage.User(text));
    }
    catch {
        return Math.ceil(text.length / 3.5); // ~3.5 chars per token estimate
    }
}
/** Returns true if the text looks like a Copilot refusal */
function isRefusal(text) {
    // Normalise curly/smart apostrophes (U+2018/2019) so the regex works
    // regardless of which apostrophe style the model uses
    const n = text.replace(/[\u2018\u2019\u201A\u201B]/g, "'");
    return /sorry[\s,]+i[\s']+can[\s']+t\s+assist|cannot assist with that|i'?m not able to help|i don'?t feel comfortable|not something i can help|outside.*what i can|can'?t help with|i'?m unable to (assist|help|provide|complete)|as an ai (assistant|language model)[,\s]+i (can'?t|cannot|am unable|won'?t)/i
        .test(n);
}
/**
 * Try streaming a prompt. Returns false (without calling onChunk) if Copilot
 * refuses. The refusal is detected in the first 200 chars of streamed text
 * or from a thrown error, so callers can retry with a simpler prompt.
 */
async function tryStream(model, prompt, onChunk, cancellationToken) {
    let buffer = '';
    let flushed = false; // true once we've emitted the initial buffered content
    try {
        const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, cancellationToken);
        for await (const fragment of response.text) {
            if (cancellationToken.isCancellationRequested) {
                break;
            }
            if (flushed) {
                // Past the refusal-check window — stream directly
                onChunk(fragment);
                continue;
            }
            buffer += fragment;
            if (buffer.length >= 300) {
                // Enough content to check for a refusal
                if (isRefusal(buffer)) {
                    return false;
                }
                onChunk(buffer); // flush the whole buffer exactly once
                buffer = '';
                flushed = true;
            }
            // else: keep accumulating until we have 300+ chars
        }
        // Short response that never crossed 300 chars
        if (!flushed) {
            if (isRefusal(buffer)) {
                return false;
            }
            if (buffer) {
                onChunk(buffer);
            }
        }
    }
    catch (err) {
        const msg = String(err?.message ?? err?.code ?? err);
        if (/blocked|content_filter|off_topic|can.t assist|cannot assist/i.test(msg)) {
            return false;
        }
        throw err;
    }
    return true;
}
/**
 * Stream a migration prompt with automatic fallback:
 *   Attempt 1 — full prompt with file snippets (token-limited)
 *   Attempt 2 — metadata-only prompt (no file content)
 *   Attempt 3 — ultra-minimal plain-english request
 */
async function streamWithFallback(model, fullPrompt, fallbackPrompt, minimalPrompt, onChunk, cancellationToken) {
    // Trim full prompt to token limit before first attempt
    const TOKEN_LIMIT = 10000;
    let prompt = fullPrompt;
    const tokenCount = await countTokens(model, prompt);
    if (tokenCount > TOKEN_LIMIT) {
        const ratio = TOKEN_LIMIT / tokenCount;
        const trimmed = prompt.slice(0, Math.floor(prompt.length * ratio * 0.85));
        const fences = (trimmed.match(/```/g) || []).length;
        prompt = fences % 2 !== 0 ? trimmed + '\n```\n' : trimmed;
    }
    if (await tryStream(model, prompt, onChunk, cancellationToken)) {
        return;
    }
    if (await tryStream(model, fallbackPrompt, onChunk, cancellationToken)) {
        return;
    }
    await tryStream(model, minimalPrompt, onChunk, cancellationToken);
}
// ─── Chunked Code Analysis ────────────────────────────────────────────────────
/**
 * Analyses ALL source files in chunks through Copilot, producing a structured
 * summary for each chunk. The summaries are then attached to the analysis and
 * included in every plan section's context so the AI understands the full
 * codebase — not just a small sample.
 *
 * Call this after the user's confirmation popup and before streamMigrationPlan.
 */
async function analyzeFilesInChunks(analysis, onProgress, cancellationToken) {
    const sourceFiles = analysis.keyFiles.filter((f) => f.type === 'source');
    if (sourceFiles.length === 0) {
        return [];
    }
    const CHUNK_SIZE = 10;
    const chunks = [];
    for (let i = 0; i < sourceFiles.length; i += CHUNK_SIZE) {
        chunks.push(sourceFiles.slice(i, i + CHUNK_SIZE));
    }
    const model = await selectModel();
    const summaries = [];
    for (let i = 0; i < chunks.length; i++) {
        if (cancellationToken.isCancellationRequested) {
            break;
        }
        onProgress(`Analyzing source files — module group ${i + 1} of ${chunks.length}…`, i, chunks.length);
        const chunk = chunks[i];
        const fileBlocks = chunk.map((f) => {
            const content = f.content.replace(/\[REDACTED:[^\]]*\]/g, '""');
            return `### ${f.path}\n\`\`\`\n${content}\n\`\`\``;
        }).join('\n\n');
        const prompt = `You are a senior software architect preparing a migration for ${analysis.repoInfo.owner}/${analysis.repoInfo.repo}.\n` +
            `Current stack: ${analysis.detectedStack.primaryLanguage} / ${analysis.detectedStack.framework}.\n\n` +
            `Analyze the following ${chunk.length} source files. For each file state:\n` +
            `- Its responsibility / what it does\n` +
            `- Key classes, functions, or API endpoints\n` +
            `- Framework-specific patterns used (routing, ORM, middleware, etc.)\n` +
            `- Migration-relevant concerns (deprecated APIs, coupling, hard-coded config, etc.)\n\n` +
            `Then add a short paragraph on how these files relate to each other.\n\n` +
            fileBlocks;
        const messages = [vscode.LanguageModelChatMessage.User(prompt)];
        let summary = '';
        try {
            const response = await model.sendRequest(messages, {}, cancellationToken);
            for await (const part of response.text) {
                summary += part;
            }
        }
        catch {
            summary = '(analysis unavailable for this chunk)';
        }
        summaries.push({ chunkIndex: i, files: chunk.map((f) => f.path), summary });
    }
    onProgress('Code analysis complete.', chunks.length, chunks.length);
    return summaries;
}
// ─── Main Service ─────────────────────────────────────────────────────────────
async function streamMigrationPlan(analysis, targetStack, options, onChunk, cancellationToken) {
    const model = await selectModel();
    const context = buildContext(analysis, targetStack);
    const metadataContext = buildContext({ ...analysis, keyFiles: [] }, targetStack);
    const sections = buildSections(analysis, targetStack, options);
    for (const section of sections) {
        if (cancellationToken.isCancellationRequested) {
            break;
        }
        // Emit the section heading immediately so the user sees progress
        onChunk(`\n\n${section.heading}\n\n`);
        // Each request = shared context + focused single-section ask
        const prompt = `You are a senior software architect producing one section of a professional migration plan. Be precise and actionable. Every file path you mention must exist in the file tree provided. Every package name must come from the dependency list. Do not invent placeholders.

${context}

---

${section.ask}`;
        // Fallback: same ask but without file snippets to reduce token usage
        const metadataPrompt = `You are a senior software architect producing one section of a professional migration plan. Be precise and actionable. Every package name must come from the dependency list provided.

${metadataContext}

---

${section.ask}`;
        const minimalPrompt = `Write the "${section.heading.replace(/^#+\s*/, '')}" section of a migration plan from ${analysis.detectedStack.framework} to ${targetStack}. Be specific and include code examples.`;
        await streamWithFallback(model, prompt, metadataPrompt, minimalPrompt, onChunk, cancellationToken);
    }
}
async function getAvailableModels() {
    try {
        const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        return models.map((m) => m.id);
    }
    catch {
        return [];
    }
}
// ─── Shared streaming helper ──────────────────────────────────────────────────
async function streamPrompt(prompt, onChunk, cancellationToken) {
    const model = await selectModel();
    const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, cancellationToken);
    let buffer = '';
    let checked = false;
    for await (const fragment of response.text) {
        if (cancellationToken.isCancellationRequested) {
            break;
        }
        if (!checked) {
            buffer += fragment;
            if (buffer.length >= 200) {
                checked = true;
                if (isRefusal(buffer)) {
                    throw new Error('Copilot declined this request. Try simplifying your analysis, reducing the number of key files, or switching to a more capable model.');
                }
                onChunk(buffer);
                buffer = '';
            }
        }
        else {
            onChunk(fragment);
        }
    }
    // Flush any remaining buffer (short responses that never crossed 200 chars)
    if (!checked) {
        if (isRefusal(buffer)) {
            throw new Error('Copilot declined this request. Try simplifying your analysis, reducing the number of key files, or switching to a more capable model.');
        }
        if (buffer) {
            onChunk(buffer);
        }
    }
}
// ─── Target Stack Recommendations ────────────────────────────────────────────
async function streamStackRecommendations(analysis, onChunk, cancellationToken) {
    const { detectedStack, repoInfo, totalFiles } = analysis;
    const deps = { ...detectedStack.dependencies, ...detectedStack.devDependencies };
    const depCount = Object.keys(deps).length;
    const prompt = `You are an expert software architect. Analyze this tech stack and suggest exactly 3 migration targets, ranked from most to least recommended for this project.

Current stack:
- Project: ${repoInfo.owner}/${repoInfo.repo} (${totalFiles} files, ${repoInfo.size} KB)
- Language: ${detectedStack.primaryLanguage} ${detectedStack.currentVersion}
- Framework: ${detectedStack.framework}
- Runtime: ${detectedStack.runtime}
- Build tool: ${detectedStack.buildTool}
- Package manager: ${detectedStack.packageManager}
- Databases: ${detectedStack.databases.join(', ') || 'None'}
- Testing: ${detectedStack.testingFrameworks.join(', ') || 'None'}
- Containers: ${detectedStack.containerized ? 'Yes (Docker)' : 'No'}
- CI/CD: ${detectedStack.ciSystem || 'None'}
- Total dependencies: ${depCount}

For each option use EXACTLY this format (no extra text before Option 1 or after Option 3):

## Option 1: [Short descriptive name]
**Effort:** Low | Medium | High | Very High
**Best for:** [one sentence on when this is the ideal choice]
**Pros:**
- [pro 1 specific to this project]
- [pro 2]
- [pro 3]
**Cons:**
- [con 1 specific to this project]
- [con 2]
[TARGET]: [exact target stack string, e.g. "Next.js 14 with App Router + TypeScript 5 + Tailwind CSS"]

## Option 2: ...

## Option 3: ...

Be specific to this project's actual dependencies and framework. Reference actual package names where relevant.`;
    await streamPrompt(prompt, onChunk, cancellationToken);
}
// ─── AI Stack Detection ───────────────────────────────────────────────────────
async function detectStackWithAI(analysis, cancellationToken) {
    const { detectedStack, repoInfo, keyFiles, totalFiles } = analysis;
    const { safe: safeFileTree } = filterFileTree(analysis.fileTree);
    const fileSnippets = keyFiles.slice(0, 6)
        .map(f => {
        const safe = f.content.replace(/\[REDACTED:[^\]]*\]/g, '""').slice(0, 400);
        return `### ${f.path}\n${safe}`;
    }).join('\n\n');
    const prompt = `You are a senior software architect. Analyze this repository and return a JSON object describing its tech stack.

Repository: ${repoInfo.owner}/${repoInfo.repo}
Total files: ${totalFiles}
Primary language (from GitHub): ${repoInfo.language}

File tree sample (${Math.min(safeFileTree.length, 200)} of ${safeFileTree.length} files):
${safeFileTree.slice(0, 200).join('\n')}

Key file contents:
${fileSnippets || '(none)'}

Return ONLY a valid JSON object — no markdown, no explanation, no code fences. Use this exact shape:
{
  "primaryLanguage": "string — e.g. TypeScript, Python, Java",
  "framework": "string — e.g. Next.js 14, Django 4.2, Spring Boot 3 (include version if detectable)",
  "runtime": "string — e.g. Node.js 20 LTS, Python 3.11, JVM 21",
  "buildTool": "string — e.g. Vite, Webpack 5, Maven, Gradle",
  "packageManager": "string — e.g. npm, pnpm, Poetry, Cargo",
  "currentVersion": "string — the main runtime version e.g. Node.js 18, Java 17",
  "containerized": true | false,
  "ciSystem": "string — e.g. GitHub Actions, Jenkins, or None",
  "databases": ["array", "of", "databases"],
  "testingFrameworks": ["array", "of", "test", "frameworks"],
  "insights": "string — 1-2 sentences on architecture patterns, notable libraries, or concerns not captured above"
}

Be specific. Use version numbers where visible. Do not guess what is not present.`;
    let raw = '';
    await streamPrompt(prompt, (chunk) => { raw += chunk; }, cancellationToken);
    // Extract JSON — handle cases where model wraps it in fences despite instructions
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        throw new Error('AI stack detection returned an unexpected format.');
    }
    let parsed;
    try {
        parsed = JSON.parse(jsonMatch[0]);
    }
    catch {
        throw new Error('AI stack detection returned malformed JSON.');
    }
    return {
        primaryLanguage: parsed.primaryLanguage || detectedStack.primaryLanguage,
        framework: parsed.framework || detectedStack.framework,
        runtime: parsed.runtime || detectedStack.runtime,
        buildTool: parsed.buildTool || detectedStack.buildTool,
        packageManager: parsed.packageManager || detectedStack.packageManager,
        currentVersion: parsed.currentVersion || detectedStack.currentVersion,
        containerized: typeof parsed.containerized === 'boolean' ? parsed.containerized : detectedStack.containerized,
        ciSystem: parsed.ciSystem || detectedStack.ciSystem,
        databases: Array.isArray(parsed.databases) ? parsed.databases : detectedStack.databases,
        testingFrameworks: Array.isArray(parsed.testingFrameworks) ? parsed.testingFrameworks : detectedStack.testingFrameworks,
        insights: parsed.insights || '',
    };
}
// ─── Stack Health Analysis ────────────────────────────────────────────────────
async function streamStackHealthAnalysis(analysis, onChunk, cancellationToken) {
    const { detectedStack, repoInfo, totalFiles } = analysis;
    const deps = { ...detectedStack.dependencies, ...detectedStack.devDependencies };
    const depList = Object.entries(maskPrivatePackages(deps)).slice(0, 30)
        .map(([k, v]) => `  ${k}: ${v}`).join('\n');
    const prompt = `You are a senior software architect performing a tech stack health audit. Be direct, specific, and opinionated.

Project: ${repoInfo.owner}/${repoInfo.repo} (${totalFiles} files, ${repoInfo.size} KB, ${repoInfo.stars} stars)
Language: ${detectedStack.primaryLanguage} ${detectedStack.currentVersion}
Framework: ${detectedStack.framework}
Runtime: ${detectedStack.runtime}
Build tool: ${detectedStack.buildTool}
Package manager: ${detectedStack.packageManager}
Databases: ${detectedStack.databases.join(', ') || 'None detected'}
Testing: ${detectedStack.testingFrameworks.join(', ') || 'None detected'}
Containers: ${detectedStack.containerized ? 'Yes (Docker)' : 'No'}
CI/CD: ${detectedStack.ciSystem || 'None detected'}
Dependencies (${Object.keys(deps).length} total):
${depList || '  (none)'}

First, output a one-line summary in this exact format:
**Health Score: X/10** — [one sentence summary of the biggest concern]

Then list every issue you find. For each issue use EXACTLY this format:

## [emoji] [Category]: [Short title]
**Impact:** High | Medium | Low
**Problem:** [What is wrong, outdated, slow, or risky — be specific, reference actual versions or package names]
**Fix:** [The specific modern replacement and why it is better — include version numbers]

Use 🔴 for High impact, 🟡 for Medium, 🟢 for Low.

Cover these categories where applicable: Runtime version, Framework version, Build tooling, Bundle size / no bundler, Dependencies (outdated/abandoned/heavy), Testing gaps, Security risks, CI/CD gaps, Missing tooling (linter/formatter/types).

Do not repeat yourself. Do not add text outside the format above. Be honest — if something is genuinely fine, skip it rather than inventing a problem.`;
    await streamPrompt(prompt, onChunk, cancellationToken);
}
// ─── Error Debug Helper (enhancement #3) ─────────────────────────────────────
async function streamDebugHelp(analysis, errorMessage, onChunk, cancellationToken) {
    const { detectedStack, repoInfo } = analysis;
    const { safe: safeFileTree } = filterFileTree(analysis.fileTree);
    const configFiles = analysis.keyFiles.filter(f => f.type !== 'source').slice(0, 4);
    const sourceFiles = analysis.keyFiles.filter(f => f.type === 'source').slice(0, 2);
    const fileContext = [...configFiles, ...sourceFiles]
        .map(f => `### ${f.path}\n\`\`\`\n${f.content.slice(0, 1500)}\n\`\`\``)
        .join('\n\n');
    const prompt = `You are an expert debugger for ${detectedStack.primaryLanguage} applications.

## Repository Context: ${repoInfo.owner}/${repoInfo.repo}
- **Stack:** ${detectedStack.framework} on ${detectedStack.runtime}
- **Build Tool:** ${detectedStack.buildTool}
- **Key Dependencies:** ${Object.entries(detectedStack.dependencies).slice(0, 15).map(([k, v]) => `${k}@${v}`).join(', ')}

## Project Files (sample)
${fileContext}

## File Tree (${Math.min(safeFileTree.length, 150)} of ${safeFileTree.length} files)
${safeFileTree.slice(0, 150).map(f => `- ${f}`).join('\n')}

---

## Error / Problem

\`\`\`
${errorMessage.slice(0, 3000)}
\`\`\`

## Your Task
Diagnose this error in the context of THIS specific codebase and provide:

### 🔍 Root Cause
Explain exactly what is causing this error, referencing specific files or patterns from the codebase above.

### 🛠️ Fix
Provide the exact code change needed to fix it. Show before/after.

### 🔎 Where to Look
List the specific files and line patterns to check first.

### 🛡️ Prevention
How to prevent this class of error in future — with a code example if applicable.

Be specific to THIS codebase. Do not give generic advice.`;
    await streamPrompt(prompt, onChunk, cancellationToken);
}
// ─── Executive Summary (enhancement #5) ──────────────────────────────────────
async function streamExecSummary(analysis, targetStack, plan, onChunk, cancellationToken) {
    const { detectedStack, repoInfo } = analysis;
    const prompt = `You are a technical lead preparing a one-page executive summary for a stakeholder meeting.

## Migration: ${repoInfo.owner}/${repoInfo.repo}
**From:** ${detectedStack.framework} / ${detectedStack.runtime}
**To:** ${targetStack}

## Full Migration Plan (for reference)
${plan.slice(0, 4000)}

---

## Your Task
Write a concise **Executive Summary** (max 1 page) that a non-technical manager can understand. Include:

### 📋 What We're Doing
One paragraph explaining the migration in plain English. No jargon.

### 📊 Effort & Timeline Estimate
| Item | Estimate |
|---|---|
| Total effort | X developer-days |
| Recommended team size | N developers |
| Suggested timeline | X weeks |
| Risk level | Low / Medium / High |

### 💰 Business Value
- 3 bullet points on why this migration matters (performance, cost, security, maintainability)

### ⚠️ Key Risks
Top 3 risks with one-line mitigation for each.

### ✅ Success Criteria
How we'll know the migration is complete and successful (3-5 measurable criteria).

### 📅 Suggested Phasing
A simple 3-row table: Phase, What happens, Duration.

Keep it under 400 words. Write for a VP of Engineering, not a developer.`;
    await streamPrompt(prompt, onChunk, cancellationToken);
}
// ─── File Previews (enhancement #1) ──────────────────────────────────────────
async function streamFilePreviews(analysis, targetStack, onChunk, cancellationToken) {
    const { detectedStack, keyFiles } = analysis;
    const fileDump = keyFiles.slice(0, 6).map(f => `### CURRENT: ${f.path}\n\`\`\`\n${f.content.slice(0, 1500)}\n\`\`\``).join('\n\n');
    const prompt = `You are a migration specialist. For each file below, produce a COMPLETE migrated version targeting: **${targetStack}**.

## Current Stack
- Language: ${detectedStack.primaryLanguage}
- Framework: ${detectedStack.framework}
- Runtime: ${detectedStack.runtime}

## Current Files
${fileDump}

## Your Task
For EACH file above, produce:

1. A brief comment explaining what changed and why
2. The **complete migrated file content** — not a diff, the full file

Format each as:

---
## 📄 \`{filename}\`
**Changes:** {one-line summary}

\`\`\`{language}
{full migrated file content}
\`\`\`

Be precise. Preserve the intent of the original code. Only change what's necessary for the target stack.`;
    await streamPrompt(prompt, onChunk, cancellationToken);
}
// ─── Progress Check (enhancement #8) ─────────────────────────────────────────
async function streamProgressCheck(analysis, targetStack, plan, branchDiff, onChunk, cancellationToken) {
    const prompt = `You are reviewing migration progress for a software project.

## Migration Goal
**From:** ${analysis.detectedStack.framework} / ${analysis.detectedStack.runtime}
**To:** ${targetStack}

## Original Migration Plan (summary)
${plan.slice(0, 2000)}

## Work-in-Progress Branch: \`${branchDiff.compareBranch}\` vs \`${branchDiff.baseBranch}\`
**Files changed:** ${branchDiff.changedFiles.length}
**Changed files:**
${branchDiff.changedFiles.slice(0, 30).map(f => `- ${f}`).join('\n')}

## Diff Sample
\`\`\`diff
${branchDiff.diffSample}
\`\`\`

## Your Task
Analyse the diff and report migration progress:

### ✅ Completed
List migration plan items that appear to be DONE based on the diff.

### 🔄 In Progress
List items that are partially done — started but not complete.

### ❌ Not Started
List plan items that have NO evidence in the diff yet.

### ⚠️ Issues Found
Any problems, regressions, or deviations from the plan visible in the diff.

### 📊 Progress Estimate
Rough completion percentage and what to tackle next.

Be specific — reference actual file names from the diff.`;
    await streamPrompt(prompt, onChunk, cancellationToken);
}
// ─── Plan Export Formatter (enhancement #4) ───────────────────────────────────
async function streamExportFormat(plan, format, repoName, targetStack, onChunk, cancellationToken) {
    const formatInstructions = {
        'checklist': `Convert the migration plan into a flat GitHub-flavoured Markdown checklist.
Every action item becomes a \`- [ ] \` checkbox.
Group by phase/section. Remove all prose — only keep actionable items.
Output ONLY the checklist, nothing else.`,
        'github-issue': `Format as a GitHub Issue body for a migration tracking issue.
Title line (first line): "Migration: ${repoName} → ${targetStack}"
Include: Summary paragraph, labelled sections, and a checklist of tasks as \`- [ ] \` items.
Add suggested GitHub labels at the top as: \`Labels: migration, tech-debt, <language>\``,
        'exec-summary': `Already handled separately.`,
        'confluence': `Convert to Confluence wiki markup.
Use Confluence macros: {code}, {panel}, {info}, {warning}, {toc}.
Use h1./h2./h3. headings. Use || table syntax.
Output ONLY Confluence markup, ready to paste.`,
    };
    const prompt = `You are formatting a migration plan for export.

## Migration Plan
${plan.slice(0, 5000)}

## Export Format Required
${formatInstructions[format]}`;
    await streamPrompt(prompt, onChunk, cancellationToken);
}
// ─── Detailed Downloadable Report ─────────────────────────────────────────────
async function streamDetailedReport(analysis, targetStack, onChunk, cancellationToken) {
    const model = await selectModel();
    const { repoInfo, detectedStack, keyFiles, fileTree } = analysis;
    const { safe } = filterFileTree(fileTree);
    const maskedDeps = maskPrivatePackages(detectedStack.dependencies);
    const maskedDevDeps = maskPrivatePackages(detectedStack.devDependencies);
    const deps = Object.entries(maskedDeps).slice(0, 20).map(([k, v]) => `  ${k}: ${v}`).join('\n');
    const devDeps = Object.entries(maskedDevDeps).slice(0, 15).map(([k, v]) => `  ${k}: ${v}`).join('\n');
    const keyFilePaths = keyFiles.map(f => f.path).join(', ');
    // Lean shared context — metadata only, no full file content
    const sharedContext = [
        `Repository: ${repoInfo.owner}/${repoInfo.repo}`,
        `Description: ${repoInfo.description || 'No description'}`,
        `Language: ${repoInfo.language} | Files: ${analysis.totalFiles} | Size: ${repoInfo.size} KB`,
        `Migration target: ${targetStack}`,
        `Current stack: ${detectedStack.primaryLanguage} ${detectedStack.currentVersion} | Framework: ${detectedStack.framework} | Runtime: ${detectedStack.runtime}`,
        `Build: ${detectedStack.buildTool} | Package manager: ${detectedStack.packageManager}`,
        `CI: ${detectedStack.ciSystem || 'None'} | Databases: ${detectedStack.databases.join(', ') || 'None'} | Containerized: ${detectedStack.containerized ? 'Yes' : 'No'}`,
        `Test frameworks: ${detectedStack.testingFrameworks.join(', ') || 'None'}`,
        `Production dependencies (top 20):\n${deps || '  (none detected)'}`,
        `Dev dependencies (top 15):\n${devDeps || '  (none detected)'}`,
        `Key files: ${keyFilePaths}`,
        `File tree sample (top 40 paths):\n${safe.slice(0, 40).join('\n')}`,
    ].join('\n');
    const sections = [
        {
            heading: '# Executive Summary',
            ask: [
                'Write an Executive Summary (4–6 paragraphs) covering:',
                '1. What this repository does and who it serves.',
                '2. Why the current stack is a liability — reference actual detected versions and EOL status.',
                '3. What the target stack delivers — specific technical and business benefits.',
                '4. The migration approach at a high level (phases, risk posture, timeline estimate).',
                '5. Expected ROI: developer productivity, performance, security, operational cost.',
            ].join('\n'),
        },
        {
            heading: '## 1. Current State Analysis',
            ask: [
                'Write the following current state subsections:',
                '',
                '### 1.1 Technology Inventory',
                'Table: Component | Detected Version | Category | Support Status | EOL Date | Risk Level | Notes',
                'Minimum 12 rows using actual dependency data. Mark EOL/unmaintained items as High risk.',
                '',
                '### 1.2 Architecture Overview',
                'Describe: application pattern, entry points, module structure, data flow, external integrations, config management, deployment model. Include ASCII architecture diagram.',
                '',
                '### 1.3 Code Quality Assessment',
                'Table: Dimension | Rating (1–5) | Observation | Impact',
                'Dimensions: Test Coverage, Documentation, Dependency Freshness, Security Posture, Build Reproducibility, Code Organisation, Error Handling, Logging & Observability, CI/CD Maturity, Container Readiness.',
                '',
                '### 1.4 Technical Debt Inventory',
                'Table: # | Debt Item | Location | Severity (Critical/High/Medium/Low) | Business Impact | Estimated Fix Effort',
                'Minimum 10 items.',
                '',
                '### 1.5 Security Vulnerability Assessment',
                'Table: Vulnerability | Affected Component | Severity | CVE/Pattern | Resolved by Migration?',
            ].join('\n'),
        },
        {
            heading: '## 2. Target State Vision',
            ask: [
                `Write the following target state subsections (migration to ${targetStack}):`,
                '',
                '### 2.1 Target Architecture',
                'Describe: application pattern, module structure, data layer, API layer, configuration. Include ASCII architecture diagram.',
                '',
                '### 2.2 Technology Mapping',
                'Table: Current Technology | Current Version | Target Technology | Target Version | Reason for Change | Migration Effort (S/M/L/XL)',
                'One row per current component.',
                '',
                '### 2.3 New Capabilities Unlocked',
                'List at least 8 new capabilities the target stack enables, with business value description for each.',
                '',
                '### 2.4 Benefits & ROI Analysis',
                'Table: Benefit Category | Current State | Target State | Improvement | Confidence',
                'Categories: Build Time, Test Execution, Boot Time, Memory Footprint, Request Latency, Developer Onboarding, Dependency Update Frequency, Security Patch Lag, Boilerplate Code.',
            ].join('\n'),
        },
        {
            heading: '## 3. Gap Analysis',
            ask: [
                'Write the following gap analysis subsections:',
                '',
                '### 3.1 Feature Parity Matrix',
                'Table: Feature/Capability | Current Implementation | Target Implementation | Parity Risk (None/Low/Medium/High) | Notes',
                'Minimum 15 rows.',
                '',
                '### 3.2 Breaking Changes',
                'For each breaking change write a named subsection with: what breaks, who is affected, mitigation (with code example), testing approach. Write at least 8 specific breaking changes.',
                '',
                '### 3.3 API & Interface Compatibility',
                'Table: Interface | Current Contract | Target Contract | Compatible? | Adapter Needed?',
                '',
                '### 3.4 Data & Storage Compatibility',
                'Cover: schema migration strategy, data transformation requirements, backward compatibility window, zero-downtime migration approach.',
            ].join('\n'),
        },
        {
            heading: '## 4. Migration Execution Plan',
            ask: [
                'Write the following execution plan subsections:',
                '',
                '### 4.1 Pre-Migration Checklist',
                'Numbered list of specific prerequisites: test baseline, CI passing, backup strategy, feature freeze policy, stakeholder communication plan.',
                '',
                '### 4.2 Phase 1 — Foundation Setup (Weeks 1–4)',
                'Goal: establish target stack skeleton alongside existing codebase. Write at least 6 detailed tasks each with: title, responsible role, files affected (use real file names), commands, before/after code examples, acceptance criteria.',
                '',
                '### 4.3 Phase 2 — Core Migration (Weeks 5–10)',
                'Goal: migrate application logic, framework, and data layer. Write at least 8 detailed tasks with code examples referencing real dependencies from the context.',
                '',
                '### 4.4 Phase 3 — Hardening & Optimisation (Weeks 11–14)',
                'Goal: full test coverage, performance targets, security compliance. Write at least 6 tasks covering test migration, performance profiling, security hardening, docs update, observability.',
                '',
                '### 4.5 Phase 4 — Cutover & Decommission (Weeks 15–16)',
                'Goal: zero-downtime production cutover. Cover: blue-green or canary steps, feature flags, DB cutover, monitoring SLAs during cutover, old stack decommission timeline.',
            ].join('\n'),
        },
        {
            heading: '## 5. File-by-File Migration Guide',
            ask: [
                `For each key file listed (${keyFilePaths}), write a dedicated subsection with:`,
                '- Current purpose: what this file does in the current stack',
                '- Migration action: Rewrite / Rename / Delete / Keep / Split / Merge',
                '- Target form: what this becomes in the new stack',
                '- Key changes: bullet list of every change required',
                '- Before (current) and After (target) code examples in fenced code blocks with language tag',
            ].join('\n'),
        },
        {
            heading: '## 6. Dependency Migration Guide',
            ask: [
                'Write the following dependency migration subsections:',
                '',
                '### 6.1 Production Dependencies to Migrate',
                'Table: Package | Current Version | Replacement | Replacement Version | Breaking Changes | Migration Command | Effort',
                'One row per detected production dependency. If no equivalent exists in target stack, state "Remove — no equivalent".',
                '',
                '### 6.2 Dev Dependencies to Migrate',
                'Same table format for dev dependencies (test frameworks, linters, bundlers, type checkers).',
                '',
                '### 6.3 New Dependencies to Add',
                'Table: Package | Version | Purpose | Why Needed | Install Command',
                '',
                '### 6.4 Dependencies to Remove',
                'Table: Package | Reason for Removal | Replaced By | Notes',
                '',
                '### 6.5 Dependency Version Lock Strategy',
                'Policy for: major version updates, security patches, automated PRs (Dependabot/Renovate), lockfile strategy.',
            ].join('\n'),
        },
        {
            heading: '## 7. Performance Improvements',
            ask: `Write at least 8 performance improvement sections for migrating from ${detectedStack.framework} to ${targetStack}. For each: improvement title as a subsection heading, current behaviour (baseline), root cause in current stack, target behaviour, implementation steps with code examples, expected gain (%), how to measure.`,
        },
        {
            heading: '## 8. Security Improvements',
            ask: [
                'Write the security improvements section:',
                '',
                '### 8.1 Vulnerability Remediation',
                'For each vulnerability addressed: title, CVE or class, current exposure, how the migration fixes it, verification steps.',
                '',
                '### 8.2 New Security Controls',
                'New security controls the target stack enables: authentication, authorisation, secrets management, input validation, dependency scanning.',
                '',
                '### 8.3 Compliance Impact',
                'How the migration affects compliance posture. Table: Control | Current | Target | Gap Closed? (cover OWASP, SOC2, GDPR as applicable)',
            ].join('\n'),
        },
        {
            heading: '## 9. Testing Strategy',
            ask: [
                'Write the testing strategy covering:',
                '- Current test coverage baseline',
                '- Tests to preserve, rewrite, and delete',
                '- New test types the target stack enables',
                '- Migration test plan phases',
                'Table: Test Type | Current Framework | Target Framework | Migration Action | Coverage Target',
            ].join('\n'),
        },
        {
            heading: '## 10. CI/CD Pipeline Migration',
            ask: [
                'Write the CI/CD pipeline migration covering:',
                '- Current pipeline overview (based on detected CI system)',
                '- Target pipeline design',
                '- Specific YAML/config changes required (with before/after code blocks)',
                '- Deployment strategy changes',
                '- Secrets and environment variable migration',
            ].join('\n'),
        },
        {
            heading: '## 11. Rollback Plan',
            ask: [
                'Write a detailed rollback plan:',
                '- Rollback triggers: conditions that warrant a rollback',
                '- Step-by-step rollback procedure for each migration phase',
                '- Data rollback strategy',
                '- Communication plan',
                '- Recovery time objective (RTO) estimate',
                'Table: Phase | Rollback Trigger | Rollback Steps | RTO | Data Impact',
            ].join('\n'),
        },
        {
            heading: '## 12. Risk Register',
            ask: 'Write a risk register for this migration. Table: # | Risk | Probability (H/M/L) | Impact (H/M/L) | Risk Score | Mitigation | Owner | Status. Minimum 12 risks specific to this migration.',
        },
        {
            heading: '## 13. Timeline & Resource Plan',
            ask: [
                'Write the timeline and resource plan:',
                '- Gantt-style text table showing phases vs weeks',
                '- Resource requirements: roles and FTE estimates per phase',
                'Table: Phase | Duration | Team Size | Roles Required | Key Deliverables | Exit Criteria',
                '- Critical path items and dependencies between phases',
            ].join('\n'),
        },
        {
            heading: '## 14. Success Metrics & KPIs',
            ask: 'Write the success metrics section. Table: KPI | Baseline | Target | Measurement Method | Review Frequency. Cover: build time, test pass rate, deployment frequency, lead time, MTTR, security score, developer satisfaction, and key performance metrics.',
        },
        {
            heading: '## 15. Appendix',
            ask: [
                'Write the appendix with these subsections:',
                '',
                '### A. Glossary',
                'Table: Term | Definition. Minimum 20 technical terms relevant to this migration that a non-specialist stakeholder needs.',
                '',
                '### B. Decision Log',
                'Table: Decision | Options Considered | Decision Made | Rationale | Date. Minimum 8 architectural decisions.',
                '',
                '### C. Reference Documentation',
                'Table: Resource | URL / Location | Relevance. Official migration guides, changelogs, and docs for every technology being changed.',
                '',
                '### D. Change Log',
                'Table: Version | Date | Author Role | Change Description.',
            ].join('\n'),
        },
    ];
    for (const section of sections) {
        if (cancellationToken.isCancellationRequested) {
            break;
        }
        onChunk(`\n\n${section.heading}\n\n`);
        const fullPrompt = `You are a principal software architect writing one section of a professional migration report.\nUse proper markdown. Reference real dependency names, versions, and file paths from the context. Do not truncate — write the section in full.\n\n${sharedContext}\n\n---\n\n${section.ask}`;
        const minimalPrompt = `Write the "${section.heading.replace(/^#+\s*/, '')}" section of a migration report from ${detectedStack.framework} to ${targetStack}. Include tables and code examples where appropriate.`;
        await streamWithFallback(model, fullPrompt, fullPrompt, minimalPrompt, onChunk, cancellationToken);
    }
}
// ─── Jira Stories Generator ───────────────────────────────────────────────────
async function streamJiraStories(analysis, targetStack, plan, config, onChunk, cancellationToken) {
    const model = await selectModel();
    const { repoInfo, detectedStack } = analysis;
    const maskedDeps = maskPrivatePackages(detectedStack.dependencies);
    const deps = Object.entries(maskedDeps).slice(0, 15).map(([k, v]) => `${k}@${v}`).join(', ');
    const sharedContext = [
        `Repository: ${repoInfo.owner}/${repoInfo.repo}`,
        `Migration: ${detectedStack.framework} (${detectedStack.primaryLanguage} ${detectedStack.currentVersion}) → ${targetStack}`,
        `Team: ${config.teamSize} members (${config.roles.join(', ')})`,
        `Sprint cadence: ${config.sprintWeeks}-week sprints`,
        `Key deps: ${deps}`,
        `Total files: ${analysis.totalFiles}`,
    ].join('\n');
    // Trim plan to keep prompt reasonable
    const planSummary = plan.slice(0, 4000);
    const allStories = [];
    const epicSections = [
        {
            epicName: 'Foundation Setup',
            ask: 'Generate Jira stories for Phase 1 — Foundation Setup: project scaffolding, build tooling, CI pipeline setup, initial target stack skeleton, developer environment setup. This phase typically spans the first 2–4 sprints.',
        },
        {
            epicName: 'Core Migration',
            ask: 'Generate Jira stories for Phase 2 — Core Migration: framework migration, dependency replacement, API layer migration, data layer migration, configuration migration. This is the largest phase, spanning several sprints.',
        },
        {
            epicName: 'Testing & Quality',
            ask: 'Generate Jira stories for Phase 3 — Testing & Quality: unit test migration, integration test updates, E2E test migration, performance testing, security audit, code quality checks.',
        },
        {
            epicName: 'Infrastructure & DevOps',
            ask: 'Generate Jira stories for Phase 4 — Infrastructure & DevOps: CI/CD pipeline migration, Docker/container updates, deployment configuration, monitoring/observability setup, secrets management.',
        },
        {
            epicName: 'Cutover & Hardening',
            ask: 'Generate Jira stories for Phase 5 — Cutover & Hardening: feature parity verification, data migration, blue-green/canary deployment, rollback preparation, documentation updates, knowledge transfer, old stack decommission.',
        },
    ];
    let storyCounter = 100;
    for (let epicIdx = 0; epicIdx < epicSections.length; epicIdx++) {
        if (cancellationToken.isCancellationRequested) {
            break;
        }
        const epic = epicSections[epicIdx];
        const epicKey = `MIGRATION-E${epicIdx + 1}`;
        onChunk(`\n\n## Epic: ${epic.epicName} (${epicKey})\n\n`);
        const prompt = `You are a senior agile project manager creating Jira user stories for a code migration project.

${sharedContext}

Migration plan summary (for context):
${planSummary}

---

${epic.ask}

For each story, output a JSON array. Each story object has:
- "summary": concise story title (max 80 chars)
- "description": detailed description with technical specifics referencing actual deps/files
- "storyPoints": Fibonacci number (1, 2, 3, 5, 8, or 13)
- "priority": "Critical" | "High" | "Medium" | "Low"
- "sprintNumber": which sprint to schedule it in (1-based, considering ${config.teamSize} team members)
- "labels": array of relevant labels (e.g. ["migration", "backend", "testing"])
- "estimatedDays": calendar days for 1 developer
- "component": area of codebase (e.g. "API Layer", "Build System", "Data Layer")
- "acceptanceCriteria": bullet-separated acceptance criteria
- "suggestions": practical tips, gotchas, or recommendations

Generate 5–10 stories for this epic. Use realistic story points proportional to effort.
Account for the team size of ${config.teamSize} when assigning sprint numbers.
Output ONLY a valid JSON array — no commentary before or after.`;
        const minimalPrompt = `Generate 5-10 Jira user stories as a JSON array for "${epic.epicName}" phase of migrating from ${detectedStack.framework} to ${targetStack}. Each story: summary, description, storyPoints (Fibonacci), priority, sprintNumber, labels, estimatedDays, component, acceptanceCriteria, suggestions. Output ONLY valid JSON array.`;
        let raw = '';
        await streamWithFallback(model, prompt, prompt, minimalPrompt, (chunk) => { raw += chunk; }, cancellationToken);
        // Parse JSON from the response
        try {
            // Extract JSON array from possible markdown fencing
            const jsonMatch = raw.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                const stories = JSON.parse(jsonMatch[0]);
                for (const s of stories) {
                    storyCounter++;
                    const story = {
                        epicKey,
                        epicName: epic.epicName,
                        storyId: `MIGRATION-${storyCounter}`,
                        summary: String(s.summary || ''),
                        description: String(s.description || ''),
                        storyPoints: [1, 2, 3, 5, 8, 13].includes(s.storyPoints) ? s.storyPoints : 3,
                        priority: ['Critical', 'High', 'Medium', 'Low'].includes(s.priority) ? s.priority : 'Medium',
                        sprint: `Sprint ${s.sprintNumber || 1} \u2014 ${epic.epicName}`,
                        sprintNumber: s.sprintNumber || 1,
                        labels: Array.isArray(s.labels) ? s.labels : ['migration'],
                        estimatedDays: Number(s.estimatedDays) || 1,
                        component: String(s.component || epic.epicName),
                        acceptanceCriteria: String(s.acceptanceCriteria || ''),
                        suggestions: String(s.suggestions || ''),
                    };
                    allStories.push(story);
                    // Stream markdown for each story
                    onChunk([
                        `### ${story.storyId}: ${story.summary}`,
                        `| Field | Value |`,
                        `|-------|-------|`,
                        `| **Story Points** | ${story.storyPoints} |`,
                        `| **Priority** | ${story.priority} |`,
                        `| **Sprint** | ${story.sprint} |`,
                        `| **Estimated Days** | ${story.estimatedDays}d |`,
                        `| **Component** | ${story.component} |`,
                        `| **Labels** | ${story.labels.join(', ')} |`,
                        ``,
                        `**Description:** ${story.description}`,
                        ``,
                        `**Acceptance Criteria:**`,
                        ...story.acceptanceCriteria.split(/[\n•\-]/).filter(Boolean).map(c => `- ${c.trim()}`),
                        ``,
                        `**Suggestions:** ${story.suggestions}`,
                        ``,
                        `---`,
                        ``,
                    ].join('\n'));
                }
            }
        }
        catch {
            onChunk(`\n> _Warning: could not parse stories for "${epic.epicName}" — raw output included above._\n\n`);
        }
    }
    // Summary section
    if (allStories.length > 0) {
        const totalPoints = allStories.reduce((sum, s) => sum + s.storyPoints, 0);
        const maxSprint = Math.max(...allStories.map(s => s.sprintNumber));
        const pointsBySprint = {};
        for (const s of allStories) {
            pointsBySprint[s.sprintNumber] = (pointsBySprint[s.sprintNumber] || 0) + s.storyPoints;
        }
        onChunk([
            `\n## Summary`,
            ``,
            `| Metric | Value |`,
            `|--------|-------|`,
            `| **Total Stories** | ${allStories.length} |`,
            `| **Total Story Points** | ${totalPoints} |`,
            `| **Estimated Sprints** | ${maxSprint} (${maxSprint * config.sprintWeeks} weeks) |`,
            `| **Team Size** | ${config.teamSize} |`,
            `| **Avg Points / Sprint** | ${Math.round(totalPoints / maxSprint)} |`,
            ``,
            `### Sprint Breakdown`,
            `| Sprint | Points | Stories |`,
            `|--------|--------|---------|`,
            ...Array.from({ length: maxSprint }, (_, i) => {
                const sprintNum = i + 1;
                const sprintStories = allStories.filter(s => s.sprintNumber === sprintNum);
                return `| Sprint ${sprintNum} | ${pointsBySprint[sprintNum] || 0} | ${sprintStories.length} |`;
            }),
            ``,
        ].join('\n'));
    }
    return allStories;
}
// --- Migration Presets Generator ----------------------------------------------
async function generatePresets(analysis, cancellationToken) {
    const { detectedStack, repoInfo, totalFiles } = analysis;
    const deps = maskPrivatePackages({ ...detectedStack.dependencies, ...detectedStack.devDependencies });
    const depCount = Object.keys(deps).length;
    const topDeps = Object.entries(deps).slice(0, 20).map(([k, v]) => `${k}@${v}`).join(', ');
    const prompt = `You are an expert software architect. Analyze this tech stack and return exactly 5 migration preset options as a JSON array.

Current stack:
- Project: ${repoInfo.owner}/${repoInfo.repo} (${totalFiles} files, ${repoInfo.size} KB)
- Language: ${detectedStack.primaryLanguage} ${detectedStack.currentVersion}
- Framework: ${detectedStack.framework}
- Runtime: ${detectedStack.runtime}
- Build tool: ${detectedStack.buildTool}
- Package manager: ${detectedStack.packageManager}
- Databases: ${detectedStack.databases.join(', ') || 'None'}
- Testing: ${detectedStack.testingFrameworks.join(', ') || 'None'}
- Containers: ${detectedStack.containerized ? 'Yes (Docker)' : 'No'}
- CI/CD: ${detectedStack.ciSystem || 'None'}
- Total dependencies: ${depCount}
- Key dependencies: ${topDeps || 'none'}

Return ONLY a valid JSON array � no markdown fences, no explanation, no text before or after the array.
Use this exact shape for each object:
{
  "id": "preset-N",
  "title": "Short descriptive name (5-8 words)",
  "targetStack": "Exact technology string e.g. Next.js 14 + TypeScript 5 + Tailwind CSS",
  "effort": "Low",
  "rationale": "1-2 sentences explaining why THIS project should consider this, referencing actual package names or versions",
  "pros": ["specific benefit 1 for this project", "specific benefit 2", "specific benefit 3"],
  "cons": ["specific tradeoff 1", "specific tradeoff 2"]
}

The effort field must be exactly one of: Low, Medium, High, Very High.
Order presets from LEAST to MOST effort (incremental upgrade first, full rewrite last). Be specific.`;
    let raw = '';
    await streamPrompt(prompt, (chunk) => { raw += chunk; }, cancellationToken);
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
        throw new Error('Preset generation returned an unexpected format.');
    }
    return JSON.parse(jsonMatch[0]);
}
// ─── Interactive Follow-up Chat ───────────────────────────────────────────────
/**
 * Stream a single chat reply grounded in the repo analysis + migration plan.
 * Sends the full conversation history so the model has multi-turn context.
 */
async function streamChatReply(analysis, plan, targetStack, history, question, onChunk, cancellationToken) {
    const model = await selectModel();
    const { repoInfo, detectedStack } = analysis;
    const { safe: safeTree } = filterFileTree(analysis.fileTree);
    // Compact repo context — enough to answer questions without burning the token budget
    const depsLine = Object.entries(maskPrivatePackages(detectedStack.dependencies))
        .slice(0, 20).map(([k, v]) => `${k}@${v}`).join(', ');
    // Smart plan truncation: try to include the whole plan. If too large,
    // keep the first 8000 chars (covers most plans fully) and note truncation.
    const MAX_PLAN = 8000;
    const planContext = plan.length > MAX_PLAN
        ? plan.slice(0, MAX_PLAN) + `\n\n… (plan truncated at ${MAX_PLAN} chars — ask me about a specific section for full detail)`
        : plan;
    // Include the codebase chunk summaries so the chat can answer code-level questions
    const chunkContext = analysis.chunkSummaries?.length
        ? `\n\n## Codebase Analysis Summary\n` +
            analysis.chunkSummaries.map((cs) => `Files: ${cs.files.join(', ')}\n${cs.summary.slice(0, 500)}`).join('\n---\n')
        : '';
    const systemContext = `You are a senior software architect and migration expert.
Answer questions about the migration plan and codebase below. Be concise, technical, and cite specific parts of the plan or files when relevant.

## Repository: ${repoInfo.owner}/${repoInfo.repo}
- Current stack: ${detectedStack.framework} / ${detectedStack.runtime}
- Target stack: ${targetStack}
- Files: ${analysis.totalFiles} | Size: ${repoInfo.size} KB
- Key deps: ${depsLine || 'none'}
- Docker: ${detectedStack.containerized ? 'yes' : 'no'} | CI: ${detectedStack.ciSystem || 'none'}
- File tree: ${safeTree.slice(0, 60).join(', ')}
${chunkContext}

## Migration Plan
${planContext}

---
Answer the user's question using the context above. If the question refers to a specific step, section, or file, quote it briefly before answering.`;
    // Build the message list: system context as first user turn, then history, then new question
    const MAX_HISTORY = 10; // keep last 10 exchanges (20 messages)
    const recentHistory = history.slice(-MAX_HISTORY * 2);
    const messages = [
        vscode.LanguageModelChatMessage.User(systemContext),
        // Anchor reply so the model stays in assistant role before real history starts
        vscode.LanguageModelChatMessage.Assistant('Understood. I have the migration context. Ask me anything about the plan, the codebase, or the migration strategy.'),
        ...recentHistory.map((m) => m.role === 'user'
            ? vscode.LanguageModelChatMessage.User(m.content)
            : vscode.LanguageModelChatMessage.Assistant(m.content)),
        vscode.LanguageModelChatMessage.User(question),
    ];
    const response = await model.sendRequest(messages, {}, cancellationToken);
    for await (const fragment of response.text) {
        if (cancellationToken.isCancellationRequested) {
            break;
        }
        onChunk(fragment);
    }
}
// ─── Stack Change Intent Detection ───────────────────────────────────────────
/**
 * Ask Copilot whether the user message is requesting a stack component swap
 * (e.g. "use Vitest instead of Jest because it's faster").
 *
 * Returns a structured StackChangeIntent when a clear swap is detected, or
 * null for regular questions / conversation turns.
 */
async function detectStackChangeIntent(userMessage, currentPlan, cancellationToken) {
    const model = await selectModel();
    // Build a compact "section digest" — heading + first 200 chars of content.
    // This lets the LLM identify WHAT tool is currently used in each section
    // even when the user's message is vague (e.g. "switch CI/CD to Jenkins"
    // without naming GitHub Actions).
    const rawSections = currentPlan.split(/(?=^#{1,3} )/m);
    const sectionDigest = rawSections.slice(0, 30).map((sec) => {
        const lines = sec.split('\n');
        const heading = lines[0].trim();
        const body = lines.slice(1).join('\n').trim().slice(0, 200);
        return body ? `${heading}\n  ${body}` : heading;
    }).join('\n\n');
    const prompt = `You are a migration-plan assistant. Analyse the user message below and decide whether it is requesting a specific technology/library/tool swap in the migration plan.

User message:
"""${userMessage}"""

Current plan sections (heading + excerpt):
${sectionDigest || '(no plan loaded yet)'}

Respond with ONLY a valid JSON object (no markdown fences, no extra text) matching one of these two shapes:
{ "intent": false }
{ "intent": true, "fromComponent": "<old>", "toComponent": "<new>", "reason": "<user reason or empty string>", "affectedSections": ["<exact heading line>", ...], "scope": "minor" }

Rules:
- Set intent=true ONLY when the user clearly wants to swap/replace a specific technology (library, runtime, database, framework, tool, CI system, etc.).
- "fromComponent" must be the EXACT name of the tool currently used in the plan (read it from the section excerpts above). Use the user's phrasing only if it matches.
- "toComponent" is the replacement the user wants.
- "affectedSections" must list the exact heading lines (verbatim from above) of every section whose content references fromComponent.
- "scope" must be "major" when the change is a primary web/backend framework swap (e.g. Flask→FastAPI, Django→FastAPI, Express→NestJS, React→Vue, React→Angular), a runtime or language change (Node.js→Go, Python→Java), or the primary database engine (MySQL→PostgreSQL counts as minor — only flag major if the access paradigm changes, e.g. SQL→MongoDB). Set "scope" to "minor" for everything else: CI/CD tool, test framework (Jest→Vitest), ORM/query builder, build tool/bundler, package manager, container orchestrator, linter, logging library, authentication library, state management library.
- Do NOT set intent=true for general questions, comparisons, or hypothetical discussions.`;
    let raw = '';
    try {
        const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, cancellationToken);
        for await (const fragment of response.text) {
            if (cancellationToken.isCancellationRequested) {
                return null;
            }
            raw += fragment;
        }
    }
    catch {
        return null;
    }
    try {
        // Strip accidental code fences the model may add despite the instruction
        const cleaned = raw.replace(/```[\w]*\n?/g, '').trim();
        const parsed = JSON.parse(cleaned);
        if (!parsed.intent) {
            return null;
        }
        return {
            fromComponent: String(parsed.fromComponent ?? ''),
            toComponent: String(parsed.toComponent ?? ''),
            reason: String(parsed.reason ?? ''),
            affectedSections: Array.isArray(parsed.affectedSections) ? parsed.affectedSections : [],
            scope: parsed.scope === 'major' ? 'major' : 'minor',
        };
    }
    catch {
        return null;
    }
}
// ─── Plan Patch Streamer ──────────────────────────────────────────────────────
/**
 * Given a detected StackChangeIntent, re-generates each affected section of
 * the plan with the new component substituted in, emitting chunks as it goes.
 * Sections that do NOT reference fromComponent are kept verbatim.
 * Calls onDone(patchedPlan) when all sections have been processed.
 */
async function streamPlanPatch(analysis, currentPlan, intent, onChunk, onDone, cancellationToken) {
    // Split the plan at each heading boundary
    const rawSections = currentPlan.split(/(?=^#{1,3} )/m);
    // Normalise affected headings for fast lookup
    const affectedNorm = new Set(intent.affectedSections.map((h) => h.toLowerCase().trim()));
    const { detectedStack, repoInfo } = analysis;
    const model = await selectModel();
    const patchedSections = [];
    for (const section of rawSections) {
        if (cancellationToken.isCancellationRequested) {
            break;
        }
        const firstLine = section.split('\n')[0].trim();
        const isAffected = affectedNorm.has(firstLine.toLowerCase()) ||
            section.toLowerCase().includes(intent.fromComponent.toLowerCase());
        if (!isAffected) {
            onChunk(section);
            patchedSections.push(section);
            continue;
        }
        // Rewrite this section with the new component
        const prompt = `You are rewriting one section of a migration plan because the user has decided to use "${intent.toComponent}" instead of "${intent.fromComponent}".
${intent.reason ? `User's reason: ${intent.reason}` : ''}

Project context:
- Repo: ${repoInfo.owner}/${repoInfo.repo}
- Source stack: ${detectedStack.framework} / ${detectedStack.runtime}
- Replace every reference to "${intent.fromComponent}" with "${intent.toComponent}" and update all commands, config snippets, and rationale accordingly.
- Keep the same heading, overall structure, and level of detail as the original.

Original section:
\`\`\`
${section.slice(0, 4000)}
\`\`\`

Output ONLY the rewritten section text (starting with the heading line). Do not add commentary or wrap in extra markdown fences.`;
        const minimalPrompt = `Rewrite the following migration plan section, replacing "${intent.fromComponent}" with "${intent.toComponent}". Keep the same structure:\n${section.slice(0, 1000)}`;
        let rewritten = '';
        await streamWithFallback(model, prompt, prompt, minimalPrompt, (chunk) => { rewritten += chunk; }, cancellationToken);
        // Emit the full rewritten section at once (avoids duplicate heading in UI)
        const finalSection = rewritten || section;
        onChunk(finalSection);
        patchedSections.push(finalSection);
    }
    onDone(patchedSections.join(''));
}
//# sourceMappingURL=copilotService.js.map