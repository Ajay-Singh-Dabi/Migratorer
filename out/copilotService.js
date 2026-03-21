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
exports.streamMigrationPlan = streamMigrationPlan;
exports.getAvailableModels = getAvailableModels;
exports.streamDebugHelp = streamDebugHelp;
exports.streamExecSummary = streamExecSummary;
exports.streamFilePreviews = streamFilePreviews;
exports.streamProgressCheck = streamProgressCheck;
exports.streamExportFormat = streamExportFormat;
exports.streamDetailedReport = streamDetailedReport;
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
    // Very short file snippets — enough to understand the codebase shape
    const fileSnippets = keyFiles.slice(0, 4)
        .map(f => {
        const safe = f.content.replace(/\[REDACTED:[^\]]*\]/g, '""').slice(0, 300);
        return `${f.path}:\n${safe}`;
    }).join('\n\n---\n\n');
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

Key files (short excerpt):
${fileSnippets || '(none)'}

File tree sample:
${safeFileTree.slice(0, 30).join('\n')}`;
}
function buildSections(analysis, targetStack, options) {
    const { detectedStack } = analysis;
    return [
        {
            heading: '## 1. Migration Feasibility Assessment',
            ask: `Based on the project context, write a Migration Feasibility Assessment covering:
- Complexity rating (Low / Medium / High / Very High) with a detailed explanation referencing the actual framework, file count, and dependency count
- Effort estimates as a table: Solo developer | Small team (2–3) | Experienced contractor — each with a week estimate and key assumptions
- A risk register table with at least 6 risks specific to this migration (columns: Risk | Likelihood | Impact | Mitigation)
- Prerequisites that must be in place before starting

Be specific to this project. Reference actual package names and versions.`,
        },
        {
            heading: '## 2. Current Stack → Target Stack Mapping',
            ask: `Write a complete stack mapping table for migrating this project to ${targetStack}.

Use a standard markdown pipe table — every row MUST start and end with |:

| Category | Current | Current Version | Target | Target Version | Change Type |
|----------|---------|-----------------|--------|----------------|-------------|
| Runtime  | ...     | ...             | ...    | ...            | ...         |

Fill every cell with real values. Cover: Runtime, Framework, Build Tool, Package Manager, State Management, Routing, Styling, Testing, Linting, Formatting, CI/CD, Deployment, Database/ORM.

Change Types: Direct upgrade / Full replacement / New addition / Remove / Keep as-is

After the table, write a short paragraph explaining the most significant changes and the rationale for each choice.`,
        },
        {
            heading: '## 3. Step-by-Step Migration Guide',
            ask: `Write a detailed, numbered step-by-step migration guide from ${analysis.detectedStack.framework} to ${targetStack}.

For each step use this structure:
### Step N: [Action title]
**Why:** [technical reason]
**Files affected:** [actual file names from this project]
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

Write at least 10 steps covering: project setup, config migration, each major file change, testing, CI/CD, and deployment.`,
        },
        {
            heading: '## 4. Dependency Migration',
            ask: `Write the full dependency migration guide for this project. Use standard markdown pipe tables (every row must start and end with |).

### Dependencies to Remove
| Package | Current Version | Reason | Replacement |
|---------|-----------------|--------|-------------|
(one row per dependency listed above — no "etc.")

### Dependencies to Add
| Package | Version | Purpose | Install Command |
|---------|---------|---------|-----------------|
(every new package needed for ${targetStack})

### Dependencies to Upgrade
| Package | From | To | Breaking Changes | Migration Notes |
|---------|------|----|-----------------|-----------------|

End with a paragraph on version lock strategy for the new stack.`,
        },
        {
            heading: '## 5. Code Pattern Changes',
            ask: `Identify every code pattern that must change when migrating from ${detectedStack.framework} to ${targetStack}.

For each pattern write:
### Pattern: [Name]
**Problem:** [why the old pattern doesn't work]
**Before** (${detectedStack.primaryLanguage}):
\`\`\`
[current code]
\`\`\`
**After** (${targetStack}):
\`\`\`
[new code]
\`\`\`
**Files that use this pattern:** [list actual filenames]

Cover at least 6 patterns: e.g. routing, config loading, data access, auth, error handling, module imports.`,
        },
        {
            heading: '## 6. Test Migration',
            ask: `Write the test migration plan for moving from "${detectedStack.testingFrameworks.join(', ') || 'no tests'}" to the testing tools in ${targetStack}.

- Current test inventory and gaps
- Framework mapping table (old → new, API differences)
- Before/after example for a unit test and integration test
- Commands to run the new test suite and measure coverage
- Coverage targets`,
            condition: options.includeTestMigration,
        },
        {
            heading: '## 7. CI/CD Pipeline Update',
            ask: `Write the complete updated CI/CD pipeline for ${targetStack} (adapt to ${detectedStack.ciSystem || 'GitHub Actions'}).

Provide a ready-to-commit YAML file covering: install, lint, type-check, test, build, and deploy stages.

\`\`\`yaml
# complete pipeline
\`\`\`

Then list every environment variable needed, what it is, and where to get it.`,
            condition: options.includeCiMigration,
        },
        {
            heading: '## 8. Docker / Container Updates',
            ask: `Analyse the current Dockerfile layer by layer, then write the complete updated Dockerfile for ${targetStack} with a comment on every changed layer.

\`\`\`dockerfile
# updated Dockerfile
\`\`\`

If docker-compose is used, provide the updated version too.`,
            condition: options.includeDockerMigration && detectedStack.containerized,
        },
        {
            heading: '## 9. Breaking Changes & Gotchas',
            ask: `List every breaking change between ${detectedStack.framework} and ${targetStack} that will affect this project.

For each breaking change:
### Breaking Change: [Name]
- **What breaks:** [specific file or API]
- **Why:** [technical root cause]
- **Fix:** [exact code change]
- **Find it:** \`[grep or search command]\`

Cover at least 6 breaking changes specific to this migration path.`,
        },
        {
            heading: '## 10. Performance & Security Improvements',
            ask: `For each improvement that ${targetStack} brings over the current ${detectedStack.framework} stack:

### [Improvement name]
- **Current limitation:** [what is slow or weak now]
- **How the new stack fixes it:** [specific mechanism]
- **Expected gain:** [quantified estimate]
- **How to enable it:** [config or code]

Cover at least 4 performance and 4 security improvements.`,
        },
        {
            heading: '## 11. Post-Migration Checklist',
            ask: `Write a numbered post-migration checklist. Every item must be specific and include a command to verify it.

1. [ ] [specific item] — verify with: \`command\`
2. [ ] ...

Include at least 15 items covering: functionality, performance, security, CI/CD, monitoring, and documentation.`,
        },
        {
            heading: '## 12. Phased Migration Schedule',
            ask: `Break this migration into 3 phases:

### Phase 1 — Foundation (no breaking changes, ships independently)
Goal, duration estimate, and task list with commands and affected files.

### Phase 2 — Core Migration (breaking changes, feature branch)
Goal, duration estimate, and task list.

### Phase 3 — Hardening & Cutover
Goal, duration estimate, and task list.`,
            condition: options.phasedMode,
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
    return /sorry[\s,]+i[\s']+can[\s']+t assist|cannot assist with that|i'm not able to help|i don't feel comfortable|not something i can help|outside.*what i can|can't help with/i
        .test(text);
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
// ─── Main Service ─────────────────────────────────────────────────────────────
async function streamMigrationPlan(analysis, targetStack, options, onChunk, cancellationToken) {
    const model = await selectModel();
    const context = buildContext(analysis, targetStack);
    const sections = buildSections(analysis, targetStack, options);
    for (const section of sections) {
        if (cancellationToken.isCancellationRequested) {
            break;
        }
        // Emit the section heading immediately so the user sees progress
        onChunk(`\n\n${section.heading}\n\n`);
        // Each request = shared context + focused single-section ask
        const prompt = `You are a software architect writing one section of a migration plan.\n\n${context}\n\n---\n\n${section.ask}\n\nBe specific — reference actual file names, package names, and versions from the context above.`;
        const minimalPrompt = `Write the "${section.heading.replace(/^#+\s*/, '')}" section of a migration plan from ${analysis.detectedStack.framework} to ${targetStack}. Be specific and include code examples.`;
        await streamWithFallback(model, prompt, prompt, minimalPrompt, onChunk, cancellationToken);
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
    for await (const fragment of response.text) {
        if (cancellationToken.isCancellationRequested) {
            break;
        }
        onChunk(fragment);
    }
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

## File Tree (sample)
${safeFileTree.slice(0, 30).map(f => `- ${f}`).join('\n')}

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
    const { repoInfo, detectedStack, keyFiles, fileTree } = analysis;
    const { safe } = filterFileTree(fileTree);
    const configFiles = keyFiles.filter(f => f.type !== 'source');
    const sourceFiles = keyFiles.filter(f => f.type === 'source');
    const renderFiles = (files) => files.map(f => `### ${f.path}\n\`\`\`\n${f.content.slice(0, 1200)}\n\`\`\``).join('\n\n');
    const deps = Object.entries(detectedStack.dependencies).slice(0, 30)
        .map(([k, v]) => `  ${k}: ${v}`).join('\n');
    const devDeps = Object.entries(detectedStack.devDependencies).slice(0, 20)
        .map(([k, v]) => `  ${k}: ${v}`).join('\n');
    const prompt = `You are a principal software architect and technical writer producing a publication-quality, boardroom-ready Migration Report. Every section must be thorough, specific, and directly derived from the actual repository data provided. Do not write generic advice — reference real file names, real dependency names, real version numbers, and real code patterns from the analysis below.

FORMATTING RULES:
- Use proper markdown: # for h1, ## for h2, ### for h3
- Every section that calls for a table MUST have a properly formatted markdown table with headers
- Every code example MUST be in a fenced code block with the language specified
- Every numbered step list MUST use 1. 2. 3. format
- Bullet points use - format
- Do NOT use emoji in headings
- Separate every major section (h1) with ---

---

# REPOSITORY DATA

## Identity
- Name: ${repoInfo.owner}/${repoInfo.repo}
- Description: ${repoInfo.description || 'No description provided'}
- Primary Language: ${repoInfo.language}
- Repository Size: ${repoInfo.size} KB
- Stars: ${repoInfo.stars}
- Default Branch: ${repoInfo.defaultBranch}
- Total File Count: ${analysis.totalFiles}

## Detected Stack
- Primary Language: ${detectedStack.primaryLanguage} ${detectedStack.currentVersion}
- Framework: ${detectedStack.framework}
- Runtime: ${detectedStack.runtime}
- Build Tool: ${detectedStack.buildTool}
- Package Manager: ${detectedStack.packageManager}
- Containerized: ${detectedStack.containerized ? 'Yes — Docker present' : 'No container detected'}
- CI/CD System: ${detectedStack.ciSystem || 'None detected'}
- Databases: ${detectedStack.databases.join(', ') || 'None detected'}
- Test Frameworks: ${detectedStack.testingFrameworks.join(', ') || 'None detected'}

## Production Dependencies (from lockfile/manifest)
${deps || '  (none detected)'}

## Dev Dependencies
${devDeps || '  (none detected)'}

## Key Configuration Files
${renderFiles(configFiles)}

## Source Entry Points
${renderFiles(sourceFiles)}

## Repository File Tree (sample)
${safe.slice(0, 100).join('\n')}

## Migration Target
${targetStack}

---

# REPORT INSTRUCTIONS

Write the complete migration report below. Follow every section exactly as specified. Each section heading must match the format shown. Do not skip, summarize, or truncate any section — write it in full. The final document will be downloaded as a professional Word/PDF report.

---

# Executive Summary

Write 4–6 paragraphs covering:
1. What this repository does and who it serves (inferred from description, stack, and file tree)
2. Why the current stack is a liability — reference actual versions detected, EOL status, known issues
3. What the target stack delivers — specific technical and business benefits
4. The migration approach at a high level (phases, risk posture, timeline estimate)
5. The expected ROI: developer productivity gain, performance improvement, security posture, operational cost

---

# 1. Current State Analysis

## 1.1 Technology Inventory

Produce a detailed table of every technology component in this repository. Include runtime, framework, build tools, databases, testing, CI, and infrastructure tooling. For each, state its exact detected version, support status, and risk level.

| Component | Detected Version | Category | Support Status | EOL Date | Risk Level | Notes |
|-----------|-----------------|----------|----------------|----------|------------|-------|

Minimum 12 rows. Use actual data from the dependency list above. Mark anything end-of-life or unmaintained as High risk.

## 1.2 Architecture Overview

Describe the current architecture in detail:
- **Application Pattern**: Is this a monolith, microservice, serverless, MVC, layered, event-driven? Justify based on file structure and dependencies.
- **Entry Points**: What are the main entry point files and what do they do?
- **Module Structure**: How is the codebase organized? Feature-based, layer-based, mixed?
- **Data Flow**: How does data move through the application — HTTP, queues, direct DB calls?
- **External Integrations**: Third-party APIs, services, or SDKs referenced in dependencies
- **Configuration Management**: How is config handled (env vars, config files, secrets)?
- **Deployment Model**: Container, bare metal, cloud function, based on what's detected

Include an ASCII architecture diagram showing the main layers/components.

## 1.3 Code Quality Assessment

For each of the following dimensions, give a rating (1–5) and a specific justification based on what was observed in the actual files:

| Dimension | Rating | Observation | Impact |
|-----------|--------|-------------|--------|

Dimensions: Test Coverage, Documentation, Dependency Freshness, Security Posture, Build Reproducibility, Code Organisation, Error Handling, Logging & Observability, CI/CD Maturity, Container Readiness

## 1.4 Technical Debt Inventory

List every observable technical debt item. Be specific — name the file or dependency where it lives.

| # | Debt Item | Location | Severity | Business Impact | Estimated Fix Effort |
|---|-----------|----------|----------|-----------------|---------------------|

Minimum 10 items. Severity: Critical / High / Medium / Low.

## 1.5 Security Vulnerability Assessment

For the current stack:
- List each known CVE category or vulnerability class associated with the detected versions
- Note any dangerous patterns visible in the code (e.g. hardcoded config, missing input validation, weak auth patterns)
- Reference the specific dependency or file where applicable

| Vulnerability | Affected Component | Severity | CVE / Pattern | Resolved by Migration? |
|---------------|--------------------|----------|---------------|------------------------|

---

# 2. Target State Vision

## 2.1 Target Architecture

Describe the proposed architecture after migration to ${targetStack}:
- **Application Pattern**: What pattern will be used in the target stack and why it fits this codebase
- **Module Structure**: How modules/packages will be organised in the new stack
- **Data Layer**: How persistence changes with the new stack
- **API Layer**: REST, GraphQL, gRPC — what changes and why
- **Configuration**: How config and secrets are managed in the target

Draw an ASCII architecture diagram for the target state. Label every component.

## 2.2 Technology Mapping

For every component in the current stack, state its exact replacement:

| Current Technology | Current Version | Target Technology | Target Version | Reason for Change | Migration Effort |
|--------------------|-----------------|-------------------|----------------|-------------------|-----------------|

Migration Effort: S (< 1 day) / M (1–3 days) / L (1–2 weeks) / XL (2+ weeks)

## 2.3 New Capabilities Unlocked

What new capabilities does the target stack enable that were impossible or impractical before? List at least 8 with a description of the business value.

## 2.4 Benefits & ROI Analysis

For each category, provide a specific, quantified estimate based on industry benchmarks for this type of migration:

| Benefit Category | Current State | Target State | Improvement | Confidence |
|------------------|---------------|--------------|-------------|------------|

Categories: Build Time, Test Execution Time, Cold Start / Boot Time, Memory Footprint, Request Latency (p99), Developer Onboarding Time, Dependency Update Frequency, Security Patch Lag, Lines of Boilerplate Code

---

# 3. Gap Analysis

## 3.1 Feature Parity Matrix

Every feature or capability in the current codebase must be accounted for in the target stack.

| Feature / Capability | Current Implementation | Target Implementation | Parity Risk | Notes |
|----------------------|------------------------|-----------------------|-------------|-------|

Minimum 15 rows. Parity Risk: None / Low / Medium / High.

## 3.2 Breaking Changes

List every breaking change that will occur during migration, with exact mitigation steps.

### [Breaking change title]
- **What breaks**: Describe exactly what API, contract, or behaviour changes
- **Who is affected**: Internal code, external consumers, downstream systems
- **Mitigation**: Step-by-step how to handle it (code example if applicable)
- **Testing approach**: How to verify the break is handled correctly

Write at least 8 breaking changes specific to this migration.

## 3.3 API & Interface Compatibility

Detail every public interface (REST endpoints, exported functions, event schemas, CLI commands) and whether it changes:

| Interface | Current Contract | Target Contract | Compatible? | Adapter Needed? |
|-----------|-----------------|-----------------|-------------|-----------------|

## 3.4 Data & Storage Compatibility

If databases or data formats are changing:
- Schema migration strategy
- Data transformation requirements
- Backward compatibility window
- Zero-downtime migration approach

---

# 4. Migration Execution Plan

## 4.1 Pre-Migration Checklist

Before any migration work begins, the following must be in place:

1. [Specific prerequisite for this repository]
2. ...

Include: test baseline, CI passing, backup strategy, feature freeze policy, stakeholder communication.

## 4.2 Phase 1 — Foundation Setup (Weeks 1–4)

**Goal**: Establish the target stack skeleton alongside the existing codebase without breaking anything.

For each task, provide:
- Task title and description
- Responsible role (e.g. Senior Engineer, DevOps)
- Files to create/modify (use actual file names from the repository)
- Exact commands to run
- Acceptance criteria (how you know it's done)
- Before/after code example where applicable

### Task 1.1 — [Specific foundational task]

**Files affected**: list real files from the repo
**Commands**:
\`\`\`bash
# actual commands here
\`\`\`
**Before**:
\`\`\`
# code before
\`\`\`
**After**:
\`\`\`
# code after
\`\`\`
**Acceptance criteria**: ...

Write at least 6 detailed tasks for Phase 1.

## 4.3 Phase 2 — Core Migration (Weeks 5–10)

**Goal**: Migrate the application logic, framework, and data layer to the target stack.

Write at least 8 detailed tasks. For each major dependency being replaced, provide the full migration steps including code rewrites. Reference real dependencies from the detected list.

## 4.4 Phase 3 — Hardening & Optimisation (Weeks 11–14)

**Goal**: Achieve full test coverage, performance targets, and security compliance on the new stack.

Write at least 6 detailed tasks covering: test migration, performance profiling and tuning, security hardening, documentation update, and observability setup.

## 4.5 Phase 4 — Cutover & Decommission (Weeks 15–16)

**Goal**: Route production traffic to the new stack with zero downtime and safely retire the old stack.

Cover: blue-green or canary deployment steps, feature flag configuration, database cutover, DNS/routing change, monitoring SLAs during cutover, old stack decommission timeline.

---

# 5. File-by-File Migration Guide

For every key file detected in the repository, provide a complete migration guide:

## [file path]
- **Current purpose**: What this file does in the current stack
- **Migration action**: Rewrite / Rename / Delete / Keep / Split / Merge
- **Target form**: What this becomes in the new stack
- **Key changes**: Bullet list of every change required
- **Before** (current):
\`\`\`[language]
// current code
\`\`\`
- **After** (target):
\`\`\`[language]
// migrated code
\`\`\`

Write this for every file listed in the key files section above.

---

# 6. Dependency Migration Guide

## 6.1 Production Dependencies to Migrate

| Package | Current Version | Replacement | Replacement Version | Breaking Changes | Migration Command | Effort |
|---------|-----------------|-------------|---------------------|-----------------|-------------------|--------|

One row per dependency detected. If a dependency has no equivalent in the target stack, state "Remove — no equivalent" and explain why.

## 6.2 Dev Dependencies to Migrate

Same table format. Include test frameworks, linters, bundlers, type checkers.

## 6.3 New Dependencies to Add

| Package | Version | Purpose | Why Needed | Install Command |
|---------|---------|---------|------------|-----------------|

## 6.4 Dependencies to Remove

| Package | Reason for Removal | Replaced By | Notes |
|---------|--------------------|-------------|-------|

## 6.5 Dependency Version Lock Strategy

How should the team manage dependency versions in the new stack? Include policy for: major version updates, security patches, automated PRs (Dependabot/Renovate), lockfile strategy.

---

# 7. Performance Improvements

For each performance improvement, provide:

## [Improvement title]
- **Current behaviour**: Specific measured or estimated baseline
- **Root cause in current stack**: Why it's slow/inefficient
- **Target behaviour**: What changes in the new stack
- **Implementation**: Step-by-step with code examples
- **Expected gain**: Specific percentage or absolute improvement estimate
- **How to measure**: Profiling command or metric to track

Write at least 8 performance improvements specific to this migration.

---

# 8. Security Improvements

## 8.1 Vulnerability Remediation

For each vulnerability addressed:

## [Vulnerability title]
- **Current risk**: Severity, affected surface, exploitation scenario
- **Affected component**: Specific dependency or code pattern
- **Target stack resolution**: How the new stack eliminates this risk
- **Additional hardening**: Any extra steps needed beyond the migration
- **Verification**: How to confirm it is fixed

Write at least 6 security improvements.

## 8.2 Security Hardening Checklist

A numbered checklist of every security best practice to implement during migration:
1. ...

Minimum 15 items covering: secrets management, input validation, auth/authz, transport security, dependency scanning, SAST, container security, logging.

---

# 9. Testing Strategy

## 9.1 Current Test Inventory

What tests exist today? What is the estimated coverage? What frameworks are used?

## 9.2 Test Migration Plan

For each existing test framework detected, describe exactly how tests must be rewritten:
- Framework mapping (old → new)
- Syntax differences with before/after examples
- Test helpers or utilities that need rewriting

## 9.3 New Test Coverage Requirements

| Layer | Framework | Coverage Target | Key Scenarios to Cover |
|-------|-----------|----------------|------------------------|

## 9.4 Test Pyramid for the Target Stack

\`\`\`
     /\\
    /E2E\\       ← 10% — UI / API contract tests
   /------\\
  /Integr. \\    ← 20% — DB, queue, external service
 /----------\\
/  Unit Tests \\  ← 70% — pure logic, isolated
\`\`\`\`

## 9.5 Pre-Cutover Test Checklist

A numbered checklist of every test that must pass before going to production.

---

# 10. CI/CD Pipeline Migration

## 10.1 Current Pipeline

Show the current pipeline structure (inferred from detected CI system: ${detectedStack.ciSystem}).

\`\`\`yaml
# Current pipeline structure
\`\`\`

## 10.2 Target Pipeline

Show the complete target pipeline YAML for the new stack. Include every stage:

\`\`\`yaml
# Full target pipeline — adapt to the detected CI system (${detectedStack.ciSystem}) or recommend GitHub Actions if none detected
\`\`\`

Cover all stages: install, lint, type-check, unit test, integration test, security scan (SAST/SCA), build, container build & push, staging deploy, smoke test, production deploy.

## 10.3 Environment Configuration

| Environment | Purpose | Deploy Trigger | Approvals Required | Config Source |
|-------------|---------|----------------|-------------------|---------------|

## 10.4 Secrets & Environment Variables Migration

List every environment variable and secret that needs to be migrated, renamed, or created:

| Variable Name | Current Usage | Target Usage | Change Type | Notes |
|---------------|---------------|--------------|-------------|-------|

---

# 11. Rollback Plan

## 11.1 Rollback Decision Criteria

State the exact conditions that trigger a rollback:
- Error rate threshold: ...
- Latency threshold: ...
- Data integrity signals: ...
- Business metric thresholds: ...

## 11.2 Rollback Runbook

Step-by-step rollback procedure, numbered:

1. [Step] — [Command or action] — [Time estimate] — [Owner role]
2. ...

## 11.3 Data Rollback Strategy

If data has been written to the new data store during the cutover window, how is it handled?
- Dual-write period strategy
- Data reconciliation process
- Point-in-time recovery steps

## 11.4 Communication Plan

| Event | Audience | Channel | Message Template |
|-------|----------|---------|-----------------|

---

# 12. Risk Register

| ID | Risk | Category | Probability | Impact | Risk Score | Mitigation Strategy | Contingency | Owner | Review Date |
|----|------|----------|-------------|--------|------------|--------------------|-----------| ------|-------------|

Minimum 15 risks. Categories: Technical, Organisational, External, Data, Security, Timeline.
Risk Score = Probability × Impact (both on 1–5 scale).
Sort by Risk Score descending.

---

# 13. Timeline & Resource Plan

## 13.1 Milestone Schedule

| Milestone | Description | Start Week | End Week | Prerequisite Milestones | Key Deliverable | Status |
|-----------|-------------|------------|----------|-------------------------|-----------------|--------|

## 13.2 Resource Requirements

| Role | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Skills Required |
|------|---------|---------|---------|---------|-----------------|

## 13.3 Effort Summary

| Phase | Engineering Days | QA Days | DevOps Days | Total Days | Calendar Weeks |
|-------|-----------------|---------|-------------|------------|----------------|

## 13.4 Critical Path

Identify the 5 tasks on the critical path — the ones where a delay causes the entire project to slip. For each, state the dependency chain.

---

# 14. Success Metrics & KPIs

## 14.1 Technical KPIs

| Metric | Measurement Method | Current Baseline | Target | Review Cadence | Owner |
|--------|--------------------|-----------------|--------|----------------|-------|

Minimum 10 metrics covering: build time, test time, deploy frequency, lead time, MTTR, error rate, p95/p99 latency, memory usage, CPU usage, dependency vulnerability count.

## 14.2 Business KPIs

| Metric | Current Baseline | 90-Day Target | 6-Month Target | How Measured |
|--------|-----------------|---------------|----------------|--------------|

## 14.3 Definition of Done

The migration is complete when ALL of the following are true:
1. [Specific, measurable criterion]
2. ...

Minimum 12 criteria.

---

# 15. Appendix

## A. Glossary

Define every technical term used in this report that a non-specialist stakeholder might not know. Minimum 20 terms, one per row in a table:

| Term | Definition |
|------|------------|

## B. Decision Log

Document the key architectural decisions made for this migration:

| Decision | Options Considered | Decision Made | Rationale | Date |
|----------|--------------------|---------------|-----------|------|

Minimum 8 decisions.

## C. Reference Documentation

| Resource | URL / Location | Relevance |
|----------|---------------|-----------|

List official migration guides, changelogs, and docs for every technology being changed.

## D. Change Log

| Version | Date | Author Role | Change Description |
|---------|------|-------------|--------------------|

---

CRITICAL INSTRUCTION: Write the ENTIRE report above from Executive Summary through Appendix D. Every section, every table, every code block. Do not say "see above" or "similar to before". Do not truncate. Do not skip any heading. The report will be exported directly to a Word document or PDF — it must be complete and professional.`;
    await streamPrompt(prompt, onChunk, cancellationToken);
}
//# sourceMappingURL=copilotService.js.map