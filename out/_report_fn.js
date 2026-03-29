"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.streamDetailedReport = streamDetailedReport;
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
//# sourceMappingURL=_report_fn.js.map