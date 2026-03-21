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
const vscode = __importStar(require("vscode"));
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
// ─── Prompt Builder ───────────────────────────────────────────────────────────
function buildMigrationPrompt(analysis, targetStack, options) {
    const { repoInfo, detectedStack, keyFiles } = analysis;
    const { owner, repo } = repoInfo;
    const keyFileSummary = keyFiles
        .slice(0, 8)
        .map((f) => `\n\n### ${f.path}\n\`\`\`\n${f.content.slice(0, 2000)}\n\`\`\``)
        .join('');
    const depsList = Object.entries(detectedStack.dependencies)
        .slice(0, 30)
        .map(([k, v]) => `  - ${k}: ${v}`)
        .join('\n');
    const devDepsList = Object.entries(detectedStack.devDependencies)
        .slice(0, 20)
        .map(([k, v]) => `  - ${k}: ${v}`)
        .join('\n');
    return `You are an expert software architect and migration specialist. Analyze the following repository and produce a comprehensive, actionable migration plan.

## Repository: ${owner}/${repo}
**Description:** ${repoInfo.description || 'No description'}
**GitHub Primary Language:** ${repoInfo.language}
**Total Files:** ${analysis.totalFiles}
**Stars:** ${repoInfo.stars}

## Detected Current Stack
- **Language:** ${detectedStack.primaryLanguage}
- **Runtime/Version:** ${detectedStack.currentVersion}
- **Framework:** ${detectedStack.framework}
- **Build Tool:** ${detectedStack.buildTool}
- **Package Manager:** ${detectedStack.packageManager}
- **Containerized:** ${detectedStack.containerized ? 'Yes (Docker)' : 'No'}
- **CI/CD:** ${detectedStack.ciSystem}
- **Databases/ORMs:** ${detectedStack.databases.join(', ') || 'None detected'}
- **Testing:** ${detectedStack.testingFrameworks.join(', ') || 'None detected'}

${depsList ? `### Production Dependencies\n${depsList}` : ''}
${devDepsList ? `### Dev Dependencies\n${devDepsList}` : ''}

## Key Configuration Files${keyFileSummary}

## File Tree Sample (first 50 files)
${analysis.fileTree.slice(0, 50).map((f) => `- ${f}`).join('\n')}

---

## Migration Target
The user wants to migrate this project to: **${targetStack}**

## Instructions
Generate a detailed, structured migration plan with the following sections:

### 1. 🔍 Migration Feasibility Assessment
- Complexity rating (Low/Medium/High/Very High) with justification
- Estimated effort (hours/days for a solo dev, a small team)
- Key risks and blockers

### 2. 🗺️ Current Stack → Target Stack Mapping
Create a clear mapping table of what changes:
| Category | Current | Target |
|---|---|---|
| Runtime | ... | ... |
| Framework | ... | ... |
| ... | ... | ... |

### 3. 📋 Step-by-Step Migration Plan
Number each step. For each step:
- **What to do** (specific action)
- **Why** (reason/benefit)
- **How** (concrete commands or code changes)
- **Potential issues** (what could go wrong)

### 4. 🔧 Dependency Changes
List:
- Dependencies to **remove**
- Dependencies to **add** (with versions)
- Dependencies to **upgrade** (with version bumps)
- Equivalent packages in the target stack

### 5. 💡 Code Patterns to Update
Based on the key files provided, identify specific code patterns that need to change:
- Show "Before" and "After" code snippets where possible
- Cover: imports, config syntax, API changes, deprecated patterns

${options.includeTestMigration ? `### 6. 🧪 Test Migration
How to migrate the test suite to the target stack's testing tools.
` : ''}

${options.includeCiMigration ? `### 7. ⚙️ CI/CD Pipeline Updates
Updated pipeline configuration for the target stack.
` : ''}

${options.includeDockerMigration && detectedStack.containerized ? `### 8. 🐳 Docker/Container Updates
Updated Dockerfile and docker-compose configuration.
` : ''}

### ${options.includeTestMigration || options.includeCiMigration ? '9' : '6'}. ⚠️ Breaking Changes & Gotchas
- Known breaking changes between current and target versions
- Common migration pitfalls for this specific stack
- Data migration concerns if any

### ${options.includeTestMigration || options.includeCiMigration ? '10' : '7'}. ✅ Post-Migration Checklist
A checklist of things to verify after migration is complete.

Be specific to THIS codebase — reference actual file names, dependency names, and patterns you see in the code above. Format output in clean Markdown.`;
}
// ─── Main Service ─────────────────────────────────────────────────────────────
async function streamMigrationPlan(analysis, targetStack, options, onChunk, cancellationToken) {
    const model = await selectModel();
    const prompt = buildMigrationPrompt(analysis, targetStack, options);
    const messages = [
        vscode.LanguageModelChatMessage.User(prompt),
    ];
    const response = await model.sendRequest(messages, {}, cancellationToken);
    for await (const fragment of response.text) {
        if (cancellationToken.isCancellationRequested) {
            break;
        }
        onChunk(fragment);
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
//# sourceMappingURL=copilotService.js.map