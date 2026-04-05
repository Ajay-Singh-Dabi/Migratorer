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
exports.parseGitHubUrl = parseGitHubUrl;
exports.scanEnvVarUsages = scanEnvVarUsages;
exports.analyzeDependencyUsage = analyzeDependencyUsage;
exports.detectMonorepoPackages = detectMonorepoPackages;
exports.analyzeRepository = analyzeRepository;
exports.parseOrgUrl = parseOrgUrl;
exports.analyzeOrg = analyzeOrg;
exports.fetchBranchDiff = fetchBranchDiff;
const vscode = __importStar(require("vscode"));
// ─── Secret Redaction ─────────────────────────────────────────────────────────
// Files that must never be fetched — too likely to contain raw secrets
const BLOCKED_FILE_PATTERNS = [
    /^\.env(\..+)?$/, // .env, .env.local, .env.production
    /\.pem$/i, // TLS certificates / private keys
    /\.key$/i, // private key files
    /\.pfx$/i, // PKCS#12 keystores
    /\.p12$/i,
    /\.jks$/i, // Java keystores
    /^secrets?\.(json|yaml|yml|toml)$/i, // secrets files
    /^credentials?(\.json)?$/i, // credentials files
    /private[-_]?key/i, // anything named private-key
    /\.kubeconfig$/i,
    /^terraform\.tfvars$/i, // Terraform variable files (often have secrets)
];
// Patterns that match common secret formats inside file content
const SECRET_PATTERNS = [
    { pattern: /(['"]?(?:password|passwd|pwd)['"]?\s*[:=]\s*)(['"][^'"]{3,}['"]|\S{6,})/gi, label: 'password' },
    { pattern: /(['"]?(?:api[_-]?key|apikey)['"]?\s*[:=]\s*)(['"][^'"]{8,}['"]|\S{8,})/gi, label: 'API key' },
    { pattern: /(['"]?(?:secret|client[_-]?secret)['"]?\s*[:=]\s*)(['"][^'"]{8,}['"]|\S{8,})/gi, label: 'secret' },
    { pattern: /(['"]?(?:auth[_-]?token|access[_-]?token)['"]?\s*[:=]\s*)(['"][^'"]{8,}['"]|\S{8,})/gi, label: 'token' },
    { pattern: /(Bearer\s+)[A-Za-z0-9\-._~+/]{20,}/gi, label: 'Bearer token' },
    { pattern: /ghp_[A-Za-z0-9]{36}/g, label: 'GitHub token' },
    { pattern: /gho_[A-Za-z0-9]{36}/g, label: 'GitHub OAuth token' },
    { pattern: /ghu_[A-Za-z0-9]{36}/g, label: 'GitHub user token' },
    { pattern: /ghs_[A-Za-z0-9]{36}/g, label: 'GitHub server token' },
    { pattern: /AKIA[0-9A-Z]{16}/g, label: 'AWS access key' },
    { pattern: /(?:aws[_-]?secret[_-]?access[_-]?key\s*=\s*)[A-Za-z0-9/+=]{40}/gi, label: 'AWS secret' },
    { pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, label: 'private key block' },
    { pattern: /(?:postgres|mysql|mongodb|redis):\/\/[^:]+:[^@\s]{3,}@/gi, label: 'connection string with password' },
    { pattern: /(?:https?:\/\/)[^:]+:[^@\s]{3,}@/gi, label: 'URL with embedded credentials' },
    { pattern: /(['"]?private[_-]?key['"]?\s*[:=]\s*)(['"][^'"]{8,}['"])/gi, label: 'private key value' },
    { pattern: /(['"]?(?:encryption|signing)[_-]?key['"]?\s*[:=]\s*)(['"][^'"]{8,}['"])/gi, label: 'encryption key' },
    { pattern: /(?:eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, label: 'JWT token' },
    { pattern: /AIza[0-9A-Za-z\-_]{35}/g, label: 'Google API key' },
    { pattern: /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g, label: 'SendGrid API key' },
    { pattern: /sk-[A-Za-z0-9]{48}/g, label: 'OpenAI API key' },
];
function isBlockedFile(filePath) {
    const filename = filePath.split('/').pop() || filePath;
    return BLOCKED_FILE_PATTERNS.some((p) => p.test(filename) || p.test(filePath));
}
function redactSecrets(content) {
    let out = content;
    let count = 0;
    for (const { pattern, label } of SECRET_PATTERNS) {
        // Reset lastIndex for global patterns (safety)
        pattern.lastIndex = 0;
        out = out.replace(pattern, (match, ...groups) => {
            count++;
            // For patterns with a prefix capture group, keep the prefix, redact only the value
            if (groups.length >= 2 && typeof groups[0] === 'string' && groups[0].length > 0 && groups[0].length < match.length) {
                return `${groups[0]}[REDACTED:${label}]`;
            }
            return `[REDACTED:${label}]`;
        });
    }
    return { redacted: out, count };
}
// ─── GitHub API Helper ────────────────────────────────────────────────────────
// Builds the correct API base path:
//   github.com          → hostname: api.github.com,        path: /repos/...
//   github.example.com  → hostname: github.example.com,    path: /api/v3/repos/...
function resolveApiTarget(hostname, path) {
    if (hostname === 'github.com') {
        return { hostname: 'api.github.com', fullPath: path };
    }
    // GitHub Enterprise Server
    return { hostname, fullPath: `/api/v3${path}` };
}
async function githubGet(path, token, hostname = 'github.com') {
    const { hostname: apiHost, fullPath } = resolveApiTarget(hostname, path);
    const url = `https://${apiHost}${fullPath}`;
    const headers = {
        'User-Agent': 'vscode-migration-assistant/1.0',
        'Accept': 'application/vnd.github+json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const res = await fetch(url, { headers });
    const text = await res.text();
    if (res.status === 404) {
        throw new Error(`Repository not found or not accessible (404). If it's private, provide a GitHub token.`);
    }
    if (res.status === 403) {
        throw new Error(`GitHub API rate limit exceeded (403). Provide a GitHub token to increase limits.`);
    }
    if (res.status >= 400) {
        throw new Error(`GitHub API error: ${res.status} - ${text}`);
    }
    try {
        return JSON.parse(text);
    }
    catch {
        throw new Error(`Failed to parse GitHub API response`);
    }
}
// ─── URL Parser ───────────────────────────────────────────────────────────────
function parseGitHubUrl(url) {
    const cleaned = url.trim()
        .replace(/\.git$/, '')
        .replace(/\/$/, '');
    // Matches any GitHub host: github.com, github.company.com, etc.
    const match = cleaned.match(/https?:\/\/([\w.-]+)\/([\w.-]+)\/([\w.-]+)/);
    if (!match) {
        throw new Error(`Invalid GitHub URL: "${url}"\n` +
            `Expected format: https://github.com/owner/repo\n` +
            `               or https://github.yourcompany.com/owner/repo`);
    }
    return { hostname: match[1], owner: match[2], repo: match[3] };
}
// ─── Fetch Repo Info ──────────────────────────────────────────────────────────
async function fetchRepoInfo(owner, repo, token, hostname = 'github.com') {
    const data = await githubGet(`/repos/${owner}/${repo}`, token, hostname);
    return {
        owner,
        repo,
        hostname,
        defaultBranch: data.default_branch || 'main',
        description: data.description || '',
        language: data.language || 'Unknown',
        stars: data.stargazers_count || 0,
        size: data.size || 0,
    };
}
// ─── Fetch File Tree ──────────────────────────────────────────────────────────
async function fetchFileTree(owner, repo, branch, token, hostname = 'github.com') {
    try {
        const data = await githubGet(`/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, token, hostname);
        if (data.truncated) {
            vscode.window.showWarningMessage('Repository is very large — file tree is truncated.');
        }
        return (data.tree || [])
            .filter((item) => item.type === 'blob')
            .map((item) => item.path);
    }
    catch {
        // Fallback: get root contents
        const items = await githubGet(`/repos/${owner}/${repo}/contents`, token, hostname);
        return (items || []).map((item) => item.path);
    }
}
// ─── Fetch File Content ───────────────────────────────────────────────────────
async function fetchFileContent(owner, repo, path, token, hostname = 'github.com') {
    try {
        const data = await githubGet(`/repos/${owner}/${repo}/contents/${path}`, token, hostname);
        if (data.content && data.encoding === 'base64') {
            return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf-8');
        }
        return null;
    }
    catch {
        return null;
    }
}
// ─── .migrationignore Support ────────────────────────────────────────────────
function parseMigrationIgnore(content) {
    return content
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((pattern) => {
        // Convert glob-style to regex (basic support)
        const escaped = pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.');
        return new RegExp(`(^|/)${escaped}($|/)`);
    });
}
function isIgnoredByMigrationIgnore(filePath, ignoreRules) {
    return ignoreRules.some((rule) => rule.test(filePath));
}
// ─── Source Code Entry Point Detection ───────────────────────────────────────
const SOURCE_ENTRY_PATTERNS = [
    // Node / TypeScript
    { pattern: /^src\/(index|app|main|server)\.(ts|js)$/, priority: 1 },
    { pattern: /^(index|app|main|server)\.(ts|js)$/, priority: 2 },
    // Routes / controllers (first match only)
    { pattern: /^src\/(routes?|controllers?|api)\/(index|main)\.(ts|js)$/, priority: 3 },
    { pattern: /^src\/routes?\.(ts|js)$/, priority: 3 },
    // Python
    { pattern: /^(main|app|run|wsgi|asgi|manage)\.py$/, priority: 1 },
    { pattern: /^src\/(main|app)\.py$/, priority: 2 },
    // Java / Kotlin — application entry points
    { pattern: /Application\.(java|kt)$/, priority: 1 },
    { pattern: /Main\.(java|kt)$/, priority: 2 },
    // Go
    { pattern: /^(main\.go|cmd\/[^/]+\/main\.go)$/, priority: 1 },
    // Rust
    { pattern: /^src\/(main|lib)\.rs$/, priority: 1 },
    // Ruby
    { pattern: /^(app\.rb|config\.ru|Rakefile)$/, priority: 1 },
    // PHP
    { pattern: /^(index|app)\.php$/, priority: 1 },
    // Config as source context
    { pattern: /^src\/config\.(ts|js|py)$/, priority: 4 },
];
function findSourceEntryPoints(fileTree, maxFiles = 5) {
    const scored = [];
    for (const filePath of fileTree) {
        for (const { pattern, priority } of SOURCE_ENTRY_PATTERNS) {
            if (pattern.test(filePath)) {
                scored.push({ path: filePath, priority });
                break;
            }
        }
    }
    return scored
        .sort((a, b) => a.priority - b.priority)
        .slice(0, maxFiles)
        .map((s) => s.path);
}
// ─── Representative Source File Sampling ─────────────────────────────────────
// Source code extensions worth sending content for
const SOURCE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.java', '.kt', '.go', '.rs', '.rb',
    '.php', '.cs', '.cpp', '.c', '.h', '.swift',
    '.vue', '.svelte',
]);
// Folders whose files don't give useful migration signal — skip them
const SKIP_SAMPLE_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
    '.next', '.nuxt', '__pycache__', '.mypy_cache', 'vendor',
    // NOTE: 'migrations' is intentionally NOT skipped — Section 8 (Data Migration Strategy)
    // needs the actual content of migration files to generate accurate schema migration plans.
    'generated', 'gen', 'proto', 'stubs',
]);
/**
 * Returns up to `maxFiles` source files sampled across the repo's folder
 * structure. Picks up to MAX_PER_FOLDER files from each top-level folder,
 * choosing shortest paths first (most central files), so the AI sees
 * representative code from every part of the project.
 */
// ─── Key Files to Detect ─────────────────────────────────────────────────────
const KEY_FILE_PATTERNS = [
    // JavaScript / Node
    { path: 'package.json', type: 'package-manager' },
    { path: 'yarn.lock', type: 'package-manager' },
    { path: 'pnpm-lock.yaml', type: 'package-manager' },
    { path: 'pnpm-workspace.yaml', type: 'config' }, // monorepo
    { path: 'lerna.json', type: 'config' }, // monorepo
    { path: 'nx.json', type: 'config' }, // monorepo (Nx)
    { path: 'turbo.json', type: 'config' }, // monorepo (Turborepo)
    { path: 'rush.json', type: 'config' }, // monorepo (Rush)
    // Python
    { path: 'requirements.txt', type: 'package-manager' },
    { path: 'pyproject.toml', type: 'package-manager' },
    { path: 'setup.py', type: 'package-manager' },
    { path: 'Pipfile', type: 'package-manager' },
    { path: 'alembic.ini', type: 'config' }, // Alembic migrations
    // Java
    { path: 'pom.xml', type: 'build-tool' },
    { path: 'build.gradle', type: 'build-tool' },
    { path: 'build.gradle.kts', type: 'build-tool' },
    { path: 'gradle.properties', type: 'config' },
    // .NET / C#
    { path: 'global.json', type: 'config' },
    { path: 'nuget.config', type: 'config' },
    { path: 'appsettings.json', type: 'config' },
    { path: 'appsettings.Development.json', type: 'config' },
    // Go
    { path: 'go.mod', type: 'package-manager' },
    { path: 'go.sum', type: 'package-manager' },
    // Rust
    { path: 'Cargo.toml', type: 'package-manager' },
    { path: 'Cargo.lock', type: 'package-manager' },
    // Ruby
    { path: 'Gemfile', type: 'package-manager' },
    { path: 'Gemfile.lock', type: 'package-manager' },
    { path: '.ruby-version', type: 'config' },
    // PHP
    { path: 'composer.json', type: 'package-manager' },
    // Config / toolchain
    { path: '.nvmrc', type: 'config' },
    { path: '.node-version', type: 'config' },
    { path: '.python-version', type: 'config' },
    { path: '.java-version', type: 'config' },
    { path: 'tsconfig.json', type: 'config' },
    { path: '.babelrc', type: 'config' },
    { path: 'babel.config.js', type: 'config' },
    { path: 'babel.config.json', type: 'config' },
    { path: 'webpack.config.js', type: 'config' },
    { path: 'vite.config.ts', type: 'config' },
    { path: 'vite.config.js', type: 'config' },
    { path: 'next.config.js', type: 'config' },
    { path: 'next.config.ts', type: 'config' },
    { path: 'nuxt.config.ts', type: 'config' },
    // Docker / CI
    { path: 'Dockerfile', type: 'docker' },
    { path: 'docker-compose.yml', type: 'docker' },
    { path: 'docker-compose.yaml', type: 'docker' },
    { path: '.github/workflows/main.yml', type: 'ci' },
    { path: '.github/workflows/ci.yml', type: 'ci' },
    { path: '.travis.yml', type: 'ci' },
    { path: 'Jenkinsfile', type: 'ci' },
    { path: '.circleci/config.yml', type: 'ci' },
    { path: 'azure-pipelines.yml', type: 'ci' },
    { path: 'azure-pipelines.yaml', type: 'ci' },
    { path: '.gitlab-ci.yml', type: 'ci' },
    { path: 'bitbucket-pipelines.yml', type: 'ci' },
    // Readme
    { path: 'README.md', type: 'readme' },
];
// ─── Stack Detection ──────────────────────────────────────────────────────────
function detectStack(keyFiles, fileTree, repoLanguage) {
    const stack = {
        primaryLanguage: repoLanguage,
        framework: 'Unknown',
        runtime: 'Unknown',
        buildTool: 'Unknown',
        packageManager: 'Unknown',
        containerized: false,
        ciSystem: 'None',
        databases: [],
        testingFrameworks: [],
        dependencies: {},
        devDependencies: {},
        currentVersion: 'Unknown',
    };
    const fileMap = new Map(keyFiles.map((f) => [f.path, f.content]));
    // Docker
    if (fileMap.has('Dockerfile') || fileMap.has('docker-compose.yml') || fileMap.has('docker-compose.yaml')) {
        stack.containerized = true;
    }
    // CI — check specific known filenames first, then fall back to any fetched workflow
    if (fileMap.has('.github/workflows/main.yml') || fileMap.has('.github/workflows/ci.yml')
        || [...fileMap.keys()].some((p) => p.startsWith('.github/workflows/') && (p.endsWith('.yml') || p.endsWith('.yaml')))) {
        stack.ciSystem = 'GitHub Actions';
    }
    else if (fileMap.has('.travis.yml')) {
        stack.ciSystem = 'Travis CI';
    }
    else if (fileMap.has('Jenkinsfile')) {
        stack.ciSystem = 'Jenkins';
    }
    else if (fileMap.has('.circleci/config.yml')) {
        stack.ciSystem = 'CircleCI';
    }
    else if (fileMap.has('azure-pipelines.yml') || fileMap.has('azure-pipelines.yaml')) {
        stack.ciSystem = 'Azure DevOps';
    }
    else if (fileMap.has('bitbucket-pipelines.yml')) {
        stack.ciSystem = 'Bitbucket Pipelines';
    }
    // Node.js / JavaScript / TypeScript
    const pkgJson = fileMap.get('package.json');
    if (pkgJson) {
        try {
            const pkg = JSON.parse(pkgJson);
            stack.primaryLanguage = fileTree.some((f) => f.endsWith('.ts')) ? 'TypeScript' : 'JavaScript';
            stack.packageManager = fileMap.has('yarn.lock') ? 'Yarn' : fileMap.has('pnpm-lock.yaml') ? 'pnpm' : 'npm';
            stack.dependencies = pkg.dependencies || {};
            stack.devDependencies = pkg.devDependencies || {};
            stack.buildTool = pkg.scripts?.build?.includes('webpack')
                ? 'Webpack'
                : pkg.scripts?.build?.includes('vite')
                    ? 'Vite'
                    : pkg.scripts?.build?.includes('tsc')
                        ? 'TypeScript Compiler'
                        : 'npm scripts';
            // Detect Node version
            const engines = pkg.engines || {};
            if (engines.node) {
                stack.runtime = `Node.js ${engines.node}`;
                stack.currentVersion = `Node.js ${engines.node}`;
            }
            else if (fileMap.has('.nvmrc')) {
                const ver = fileMap.get('.nvmrc')?.trim();
                stack.runtime = `Node.js ${ver}`;
                stack.currentVersion = `Node.js ${ver}`;
            }
            else {
                stack.runtime = 'Node.js (version unspecified)';
            }
            // Detect framework
            const deps = { ...stack.dependencies, ...stack.devDependencies };
            if (deps['next']) {
                stack.framework = `Next.js ${deps['next']}`;
            }
            else if (deps['nuxt'] || deps['nuxt3']) {
                stack.framework = `Nuxt ${deps['nuxt'] || deps['nuxt3']}`;
            }
            else if (deps['@angular/core']) {
                stack.framework = `Angular ${deps['@angular/core']}`;
            }
            else if (deps['react']) {
                stack.framework = `React ${deps['react']}`;
            }
            else if (deps['vue']) {
                stack.framework = `Vue ${deps['vue']}`;
            }
            else if (deps['svelte']) {
                stack.framework = `Svelte ${deps['svelte']}`;
            }
            else if (deps['express']) {
                stack.framework = `Express ${deps['express']}`;
            }
            else if (deps['fastify']) {
                stack.framework = `Fastify ${deps['fastify']}`;
            }
            else if (deps['@nestjs/core']) {
                stack.framework = `NestJS ${deps['@nestjs/core']}`;
            }
            else if (deps['koa']) {
                stack.framework = `Koa ${deps['koa']}`;
            }
            // Testing
            if (deps['jest'] || deps['@jest/core']) {
                stack.testingFrameworks.push('Jest');
            }
            if (deps['vitest']) {
                stack.testingFrameworks.push('Vitest');
            }
            if (deps['mocha']) {
                stack.testingFrameworks.push('Mocha');
            }
            if (deps['cypress']) {
                stack.testingFrameworks.push('Cypress');
            }
            if (deps['playwright'] || deps['@playwright/test']) {
                stack.testingFrameworks.push('Playwright');
            }
            // Databases
            if (deps['mongoose'] || deps['mongodb']) {
                stack.databases.push('MongoDB');
            }
            if (deps['pg'] || deps['postgres']) {
                stack.databases.push('PostgreSQL');
            }
            if (deps['mysql'] || deps['mysql2']) {
                stack.databases.push('MySQL');
            }
            if (deps['redis'] || deps['ioredis']) {
                stack.databases.push('Redis');
            }
            if (deps['prisma'] || deps['@prisma/client']) {
                stack.databases.push('Prisma ORM');
            }
            if (deps['typeorm']) {
                stack.databases.push('TypeORM');
            }
            if (deps['sequelize']) {
                stack.databases.push('Sequelize ORM');
            }
            if (deps['drizzle-orm']) {
                stack.databases.push('Drizzle ORM');
            }
        }
        catch { /* ignore parse errors */ }
    }
    // Python
    const reqTxt = fileMap.get('requirements.txt') || fileMap.get('Pipfile');
    const pyprojectToml = fileMap.get('pyproject.toml');
    if (reqTxt || pyprojectToml) {
        stack.primaryLanguage = 'Python';
        stack.packageManager = fileMap.has('Pipfile') ? 'Pipenv' : fileMap.has('pyproject.toml') ? 'Poetry/pip' : 'pip';
        const src = reqTxt || pyprojectToml || '';
        if (src.includes('django')) {
            stack.framework = 'Django';
        }
        else if (src.includes('flask')) {
            stack.framework = 'Flask';
        }
        else if (src.includes('fastapi')) {
            stack.framework = 'FastAPI';
        }
        else if (src.includes('tornado')) {
            stack.framework = 'Tornado';
        }
        if (src.includes('pytest')) {
            stack.testingFrameworks.push('pytest');
        }
        if (src.includes('unittest')) {
            stack.testingFrameworks.push('unittest');
        }
        // Python databases & ORMs
        if (src.includes('sqlalchemy') || src.includes('SQLAlchemy')) {
            stack.databases.push('SQLAlchemy');
        }
        if (src.includes('alembic')) {
            stack.databases.push('Alembic migrations');
        }
        if (src.includes('psycopg2') || src.includes('asyncpg')) {
            stack.databases.push('PostgreSQL');
        }
        if (src.includes('pymysql') || src.includes('mysqlclient')) {
            stack.databases.push('MySQL');
        }
        if (src.includes('pymongo') || src.includes('motor')) {
            stack.databases.push('MongoDB');
        }
        if (src.includes('redis') || src.includes('aioredis')) {
            stack.databases.push('Redis');
        }
        if (src.includes('celery')) {
            stack.databases.push('Celery (task queue)');
        }
        if (src.includes('tortoise-orm')) {
            stack.databases.push('Tortoise ORM');
        }
        if (src.includes('peewee')) {
            stack.databases.push('Peewee ORM');
        }
        const pyVer = fileMap.get('.python-version');
        if (pyVer) {
            stack.runtime = `Python ${pyVer.trim()}`;
            stack.currentVersion = `Python ${pyVer.trim()}`;
        }
        else {
            stack.runtime = 'Python (version unspecified)';
        }
    }
    // Java
    const pomXml = fileMap.get('pom.xml');
    const buildGradle = fileMap.get('build.gradle') || fileMap.get('build.gradle.kts');
    if (pomXml || buildGradle) {
        stack.primaryLanguage = 'Java';
        stack.buildTool = pomXml ? 'Maven' : 'Gradle';
        stack.packageManager = pomXml ? 'Maven' : 'Gradle';
        const src = pomXml || buildGradle || '';
        if (src.includes('spring-boot') || src.includes('spring-boot-starter')) {
            stack.framework = 'Spring Boot';
        }
        else if (src.includes('quarkus')) {
            stack.framework = 'Quarkus';
        }
        else if (src.includes('micronaut')) {
            stack.framework = 'Micronaut';
        }
        // Java databases, ORMs, migration tools
        if (src.includes('spring-data') || src.includes('spring.data')) {
            stack.databases.push('Spring Data');
        }
        if (src.includes('hibernate') || src.includes('jakarta.persistence')) {
            stack.databases.push('Hibernate / JPA');
        }
        if (src.includes('flyway')) {
            stack.databases.push('Flyway migrations');
        }
        if (src.includes('liquibase')) {
            stack.databases.push('Liquibase migrations');
        }
        if (src.includes('postgresql') || src.includes('org.postgresql')) {
            stack.databases.push('PostgreSQL');
        }
        if (src.includes('mysql-connector') || src.includes('com.mysql')) {
            stack.databases.push('MySQL');
        }
        if (src.includes('mongodb') || src.includes('spring-data-mongodb')) {
            stack.databases.push('MongoDB');
        }
        if (src.includes('redis') || src.includes('spring-data-redis')) {
            stack.databases.push('Redis');
        }
        if (src.includes('jooq')) {
            stack.databases.push('jOOQ');
        }
        if (src.includes('mybatis')) {
            stack.databases.push('MyBatis');
        }
        // Detect Java version from pom.xml
        const javaVerMatch = src.match(/<java\.version>([\d.]+)<\/java\.version>/) ||
            src.match(/sourceCompatibility\s*=\s*['"]?([\d.]+)/) ||
            src.match(/javaVersion\s*=\s*['"]?([\d.]+)/);
        if (javaVerMatch) {
            stack.runtime = `Java ${javaVerMatch[1]}`;
            stack.currentVersion = `Java ${javaVerMatch[1]}`;
        }
        else {
            stack.runtime = 'Java (version unspecified)';
        }
    }
    // Go
    const goMod = fileMap.get('go.mod');
    if (goMod) {
        stack.primaryLanguage = 'Go';
        stack.packageManager = 'Go modules';
        stack.buildTool = 'go build';
        const goVerMatch = goMod.match(/^go\s+([\d.]+)/m);
        if (goVerMatch) {
            stack.runtime = `Go ${goVerMatch[1]}`;
            stack.currentVersion = `Go ${goVerMatch[1]}`;
        }
        if (goMod.includes('gin-gonic/gin')) {
            stack.framework = 'Gin';
        }
        else if (goMod.includes('labstack/echo')) {
            stack.framework = 'Echo';
        }
        else if (goMod.includes('gorilla/mux')) {
            stack.framework = 'Gorilla Mux';
        }
        else if (goMod.includes('go-chi/chi')) {
            stack.framework = 'Chi';
        }
        else if (goMod.includes('gofiber/fiber')) {
            stack.framework = 'Fiber';
        }
        // Go databases
        if (goMod.includes('gorm.io/gorm')) {
            stack.databases.push('GORM');
        }
        if (goMod.includes('jackc/pgx') || goMod.includes('lib/pq')) {
            stack.databases.push('PostgreSQL');
        }
        if (goMod.includes('go-sql-driver/mysql')) {
            stack.databases.push('MySQL');
        }
        if (goMod.includes('go-redis/redis') || goMod.includes('redis/go-redis')) {
            stack.databases.push('Redis');
        }
        if (goMod.includes('mongodb/mongo-go-driver')) {
            stack.databases.push('MongoDB');
        }
        if (goMod.includes('jmoiron/sqlx')) {
            stack.databases.push('sqlx');
        }
        if (goMod.includes('entgo.io/ent')) {
            stack.databases.push('ent ORM');
        }
        if (goMod.includes('golang-migrate/migrate') || goMod.includes('pressly/goose')) {
            stack.databases.push('DB migrations');
        }
    }
    // Rust
    const cargoToml = fileMap.get('Cargo.toml');
    if (cargoToml) {
        stack.primaryLanguage = 'Rust';
        stack.packageManager = 'Cargo';
        stack.buildTool = 'cargo build';
        if (cargoToml.includes('actix-web')) {
            stack.framework = 'Actix Web';
        }
        else if (cargoToml.includes('axum')) {
            stack.framework = 'Axum';
        }
        else if (cargoToml.includes('rocket')) {
            stack.framework = 'Rocket';
        }
    }
    // .NET / C#
    const globalJson = fileMap.get('global.json');
    const hasCsproj = fileTree.some((f) => f.endsWith('.csproj'));
    const slnFile = fileTree.some((f) => f.endsWith('.sln'));
    if (globalJson || hasCsproj || slnFile) {
        stack.primaryLanguage = 'C#';
        stack.buildTool = 'dotnet build';
        stack.packageManager = 'NuGet';
        // Detect .NET version from global.json
        try {
            if (globalJson) {
                const gj = JSON.parse(globalJson);
                const sdkVersion = gj?.sdk?.version;
                if (sdkVersion) {
                    stack.runtime = `.NET ${sdkVersion}`;
                    stack.currentVersion = `.NET ${sdkVersion}`;
                }
            }
        }
        catch { /* ignore */ }
        if (stack.runtime === 'Unknown') {
            stack.runtime = '.NET (version from global.json or .csproj)';
        }
        // Detect ASP.NET framework from any fetched .csproj content
        const csprojContent = [...fileMap.entries()].find(([k]) => k.endsWith('.csproj'))?.[1];
        if (csprojContent) {
            if (csprojContent.includes('Microsoft.AspNetCore')) {
                stack.framework = 'ASP.NET Core';
            }
            else if (csprojContent.includes('Blazor')) {
                stack.framework = 'Blazor';
            }
            else {
                stack.framework = '.NET Application';
            }
            // Detect target framework
            const tfmMatch = csprojContent.match(/<TargetFramework>(net[\d.]+)<\/TargetFramework>/);
            if (tfmMatch) {
                stack.runtime = tfmMatch[1];
                stack.currentVersion = tfmMatch[1];
            }
        }
        else {
            stack.framework = 'ASP.NET Core';
        }
    }
    // Ruby
    const gemfile = fileMap.get('Gemfile');
    if (gemfile) {
        stack.primaryLanguage = 'Ruby';
        stack.packageManager = 'Bundler';
        stack.buildTool = 'rake';
        if (gemfile.includes("'rails'") || gemfile.includes('"rails"')) {
            stack.framework = 'Ruby on Rails';
        }
        else if (gemfile.includes("'sinatra'")) {
            stack.framework = 'Sinatra';
        }
        if (gemfile.includes("'rspec'") || gemfile.includes('"rspec"')) {
            stack.testingFrameworks.push('RSpec');
        }
        if (gemfile.includes("'minitest'")) {
            stack.testingFrameworks.push('Minitest');
        }
        const rubyVer = fileMap.get('.ruby-version');
        if (rubyVer) {
            stack.runtime = `Ruby ${rubyVer.trim()}`;
            stack.currentVersion = `Ruby ${rubyVer.trim()}`;
        }
        else {
            stack.runtime = 'Ruby (version unspecified)';
        }
    }
    // PHP
    const composerJson = fileMap.get('composer.json');
    if (composerJson) {
        stack.primaryLanguage = 'PHP';
        stack.packageManager = 'Composer';
        stack.buildTool = 'composer';
        try {
            const comp = JSON.parse(composerJson);
            const allDeps = { ...comp.require, ...comp['require-dev'] };
            if (allDeps['laravel/framework']) {
                stack.framework = `Laravel ${allDeps['laravel/framework']}`;
            }
            else if (allDeps['symfony/symfony'] || allDeps['symfony/framework-bundle']) {
                stack.framework = 'Symfony';
            }
            else if (allDeps['slim/slim']) {
                stack.framework = 'Slim';
            }
            const phpVer = allDeps['php'];
            if (phpVer) {
                stack.runtime = `PHP ${phpVer}`;
                stack.currentVersion = `PHP ${phpVer}`;
            }
            else {
                stack.runtime = 'PHP (version unspecified)';
            }
            if (allDeps['phpunit/phpunit']) {
                stack.testingFrameworks.push('PHPUnit');
            }
            if (allDeps['pestphp/pest']) {
                stack.testingFrameworks.push('Pest');
            }
            // Databases
            if (allDeps['doctrine/orm'] || allDeps['doctrine/dbal']) {
                stack.databases.push('Doctrine ORM');
            }
            if (allDeps['illuminate/database']) {
                stack.databases.push('Eloquent ORM');
            }
        }
        catch { /* ignore */ }
    }
    // ── Monorepo detection ────────────────────────────────────────────────────
    // Monorepo tools are language-agnostic and override nothing — they add context
    const monoMarkers = [
        ['lerna.json', 'Lerna'],
        ['nx.json', 'Nx'],
        ['turbo.json', 'Turborepo'],
        ['rush.json', 'Rush'],
        ['pnpm-workspace.yaml', 'pnpm workspaces'],
    ];
    const monoTool = monoMarkers.find(([f]) => fileMap.has(f));
    if (monoTool) {
        // Annotate framework with monorepo context rather than overwriting it
        const suffix = ` [monorepo: ${monoTool[1]}]`;
        stack.framework = stack.framework ? `${stack.framework}${suffix}` : monoTool[1];
    }
    else {
        // Check package.json workspaces field for npm/yarn monorepos
        try {
            const pkgJson = fileMap.get('package.json');
            if (pkgJson) {
                const pkg = JSON.parse(pkgJson);
                if (Array.isArray(pkg.workspaces)) {
                    const suffix = ' [monorepo: npm/yarn workspaces]';
                    stack.framework = stack.framework ? `${stack.framework}${suffix}` : 'Node.js monorepo';
                }
            }
        }
        catch { /* ignore */ }
    }
    return stack;
}
// ─── Environment Variable Scanner ────────────────────────────────────────────
/**
 * Scans source and config files for every environment variable reference
 * across all major languages. Returns a deduplicated list sorted by usage count.
 */
function scanEnvVarUsages(keyFiles) {
    const varMap = new Map();
    // Each entry: [regex, nameGroup, defaultValueGroup | undefined]
    // All regexes use named or positional groups — nameGroup is always 1.
    const patterns = [
        // JS / TS: process.env.VAR or process.env['VAR']
        [/process\.env\.([A-Z_][A-Z0-9_]+)/g, 1, undefined],
        [/process\.env\[['"]([A-Z_][A-Z0-9_]+)['"]\]/g, 1, undefined],
        // Python: os.getenv('VAR', 'default') or os.environ.get('VAR') or os.environ['VAR']
        [/os\.getenv\(['"]([A-Z_][A-Z0-9_]+)['"](?:,\s*['"]([^'"]*)['"'])?\)/g, 1, 2],
        [/os\.environ\.get\(['"]([A-Z_][A-Z0-9_]+)['"](?:,\s*['"]([^'"]*)['"'])?\)/g, 1, 2],
        [/os\.environ\[['"]([A-Z_][A-Z0-9_]+)['"]\]/g, 1, undefined],
        // Java / Kotlin: System.getenv("VAR")
        [/System\.getenv\(["']([A-Z_][A-Z0-9_]+)["']\)/g, 1, undefined],
        // Go: os.Getenv("VAR")
        [/os\.Getenv\(["']([A-Z_][A-Z0-9_]+)["']\)/g, 1, undefined],
        // Ruby: ENV['VAR'] or ENV["VAR"] or ENV.fetch('VAR', 'default')
        [/ENV\[['"]([A-Z_][A-Z0-9_]+)['"]\]/g, 1, undefined],
        [/ENV\.fetch\(['"]([A-Z_][A-Z0-9_]+)['"](?:,\s*['"]([^'"]*)['"'])?\)/g, 1, 2],
        // PHP: getenv('VAR') or $_ENV['VAR'] or $_SERVER['VAR']
        [/getenv\(['"]([A-Z_][A-Z0-9_]+)['"]\)/g, 1, undefined],
        [/\$_ENV\[['"]([A-Z_][A-Z0-9_]+)['"]\]/g, 1, undefined],
        [/\$_SERVER\[['"]([A-Z_][A-Z0-9_]+)['"]\]/g, 1, undefined],
        // .NET: Environment.GetEnvironmentVariable("VAR")
        [/Environment\.GetEnvironmentVariable\(["']([A-Za-z_][A-Za-z0-9_]+)["']\)/g, 1, undefined],
        // Rust: env::var("VAR")
        [/env::var\(["']([A-Z_][A-Z0-9_]+)["']\)/g, 1, undefined],
    ];
    for (const file of keyFiles) {
        if (file.type !== 'source' && file.type !== 'config' && file.type !== 'ci') {
            continue;
        }
        const content = file.content;
        for (const [re, nameGroup, defaultGroup] of patterns) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(content)) !== null) {
                const name = m[nameGroup];
                if (!name || name.length < 2) {
                    continue;
                }
                if (!varMap.has(name)) {
                    varMap.set(name, { files: new Set() });
                }
                const entry = varMap.get(name);
                entry.files.add(file.path);
                if (defaultGroup && m[defaultGroup] && !entry.defaultValue) {
                    entry.defaultValue = m[defaultGroup];
                }
            }
        }
    }
    return Array.from(varMap.entries())
        .map(([name, { files, defaultValue }]) => ({
        name,
        files: Array.from(files),
        ...(defaultValue !== undefined ? { defaultValue } : {}),
    }))
        .sort((a, b) => b.files.length - a.files.length); // most-referenced first
}
// ─── Dependency Usage Analyzer ────────────────────────────────────────────────
/**
 * For each production/dev dependency, counts how many source files actually
 * import it. Helps identify truly unused deps and surface the most critical ones.
 */
function analyzeDependencyUsage(deps, keyFiles) {
    const result = {};
    const sourceFiles = keyFiles.filter((f) => f.type === 'source');
    for (const [name] of Object.entries(deps).slice(0, 40)) {
        // Build a regex-safe version of the package name (handles @org/pkg, hyphens, dots)
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Match: import '...name...', require('...name...'), from '...name...'
        const re = new RegExp(`(?:import|require|from)\\s+['"\`]${escaped}(?:[/'"\`]|$)`, 'i');
        const matchingFiles = [];
        for (const file of sourceFiles) {
            if (re.test(file.content)) {
                matchingFiles.push(file.path);
            }
        }
        result[name] = { usageCount: matchingFiles.length, files: matchingFiles };
    }
    return result;
}
// ─── Monorepo Package Detector ────────────────────────────────────────────────
/**
 * Reads workspace configuration files (pnpm-workspace.yaml, lerna.json,
 * package.json#workspaces) to enumerate individual package names in a monorepo.
 */
function detectMonorepoPackages(fileTree, keyFiles) {
    const fileMap = new Map(keyFiles.map((f) => [f.path, f.content]));
    const packages = new Set();
    // Helper: given a glob prefix like "packages/", find matching package dirs
    const findPackagesUnderPrefix = (prefix) => {
        const clean = prefix.replace(/\*.*$/, '').replace(/\/$/, '') + '/';
        return fileTree
            .filter((p) => p.startsWith(clean) && p.endsWith('/package.json'))
            .map((p) => p.slice(clean.length).split('/')[0])
            .filter(Boolean);
    };
    // pnpm-workspace.yaml
    const pnpmWs = fileMap.get('pnpm-workspace.yaml');
    if (pnpmWs) {
        const globs = [...pnpmWs.matchAll(/['"]([^'"]+\*[^'"]*)['"]/g)].map((m) => m[1]);
        for (const g of globs) {
            findPackagesUnderPrefix(g).forEach((p) => packages.add(p));
        }
    }
    // lerna.json
    const lernaJson = fileMap.get('lerna.json');
    if (lernaJson) {
        try {
            const lerna = JSON.parse(lernaJson);
            for (const pattern of lerna.packages ?? []) {
                findPackagesUnderPrefix(pattern).forEach((p) => packages.add(p));
            }
        }
        catch { /* ignore */ }
    }
    // package.json#workspaces (npm / Yarn / Nx)
    const pkgJson = fileMap.get('package.json');
    if (pkgJson) {
        try {
            const pkg = JSON.parse(pkgJson);
            const workspaces = Array.isArray(pkg.workspaces)
                ? pkg.workspaces
                : (pkg.workspaces?.packages ?? []);
            for (const pattern of workspaces) {
                findPackagesUnderPrefix(pattern).forEach((p) => packages.add(p));
            }
        }
        catch { /* ignore */ }
    }
    return [...packages].sort();
}
// ─── Main Analyzer ────────────────────────────────────────────────────────────
async function analyzeRepository(repoUrl, token, onProgress) {
    const STEPS = 5;
    onProgress('Parsing repository URL…', 1, STEPS);
    const { owner, repo, hostname } = parseGitHubUrl(repoUrl);
    onProgress(`Fetching repository info for ${owner}/${repo} on ${hostname}…`, 2, STEPS);
    const repoInfo = await fetchRepoInfo(owner, repo, token, hostname);
    onProgress('Loading file tree…', 3, STEPS);
    const fileTree = await fetchFileTree(owner, repo, repoInfo.defaultBranch, token, hostname);
    // ── .migrationignore support ───────────────────────────────────────────────
    const migrationIgnoreRaw = await fetchFileContent(owner, repo, '.migrationignore', token, hostname);
    const ignoreRules = migrationIgnoreRaw ? parseMigrationIgnore(migrationIgnoreRaw) : [];
    onProgress('Reading config and source files…', 4, STEPS);
    // Find which key config files exist in this repo
    const existingKeyFiles = KEY_FILE_PATTERNS.filter((kf) => fileTree.includes(kf.path) && !isIgnoredByMigrationIgnore(kf.path, ignoreRules));
    // Also find CI workflows
    const ciWorkflows = fileTree.filter((f) => f.startsWith('.github/workflows/') && (f.endsWith('.yml') || f.endsWith('.yaml')) && !isIgnoredByMigrationIgnore(f, ignoreRules)).slice(0, 5);
    // .NET: dynamically find *.csproj files (can't be listed statically in KEY_FILE_PATTERNS)
    const csprojFiles = fileTree
        .filter((f) => f.endsWith('.csproj') && !isIgnoredByMigrationIgnore(f, ignoreRules)
        && !existingKeyFiles.some((kf) => kf.path === f))
        .slice(0, 3)
        .map((p) => ({ path: p, type: 'build-tool' }));
    // Collect ALL source files up to MAX_SOURCE_FILES — these are what the
    // chunked LLM analysis will process. We sort by path length (shallowest/most
    // central files first) so the most important code is fetched within the limit.
    const MAX_SOURCE_FILES = 80;
    const configPaths = new Set([
        ...existingKeyFiles.map((kf) => kf.path),
        ...csprojFiles.map((c) => c.path),
        ...ciWorkflows,
    ]);
    const allSourceFiles = fileTree
        .filter((p) => {
        if (configPaths.has(p)) {
            return false;
        }
        const ext = '.' + p.split('.').pop();
        if (!SOURCE_EXTENSIONS.has(ext)) {
            return false;
        }
        if (isIgnoredByMigrationIgnore(p, ignoreRules)) {
            return false;
        }
        if (isBlockedFile(p)) {
            return false;
        }
        const topFolder = p.split('/')[0];
        return !SKIP_SAMPLE_DIRS.has(topFolder);
    })
        .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
        .slice(0, MAX_SOURCE_FILES);
    const allToFetch = [
        ...existingKeyFiles,
        ...csprojFiles.filter((c) => !existingKeyFiles.some((kf) => kf.path === c.path)),
        ...ciWorkflows
            .filter((p) => !existingKeyFiles.some((kf) => kf.path === p))
            .map((p) => ({ path: p, type: 'ci' })),
        ...allSourceFiles
            .map((p) => ({ path: p, type: 'source' })),
    ];
    onProgress(`Fetching ${allToFetch.length} files and scanning for secrets…`, 5, STEPS);
    const skippedFiles = [];
    const filesWithSecrets = [];
    let totalRedactions = 0;
    const keyFiles = (await Promise.all(allToFetch.map(async ({ path, type }) => {
        // Block sensitive files entirely — never fetch them
        if (isBlockedFile(path)) {
            skippedFiles.push(path);
            return null;
        }
        const raw = await fetchFileContent(owner, repo, path, token, hostname);
        if (!raw) {
            return null;
        }
        // Config files can be large (lock files etc.) — truncate generously.
        // Source files: 6 000 chars gives ~150 lines of code — enough to capture
        // class/function signatures, key imports, and representative logic for
        // accurate before/after migration examples.
        const limit = type === 'source' ? 6000 : 8000;
        const truncated = raw.length > limit ? raw.slice(0, limit) + '\n... (truncated)' : raw;
        // Redact secrets from the content
        const { redacted, count } = redactSecrets(truncated);
        if (count > 0) {
            filesWithSecrets.push(path);
            totalRedactions += count;
        }
        return { path, type, content: redacted, redactedCount: count };
    }))).filter((f) => f !== null);
    const redactionSummary = {
        totalRedactions,
        filesWithSecrets,
        skippedFiles,
    };
    const detectedStack = detectStack(keyFiles, fileTree, repoInfo.language);
    const envVarInventory = scanEnvVarUsages(keyFiles);
    const dependencyUsage = analyzeDependencyUsage({ ...detectedStack.dependencies, ...detectedStack.devDependencies }, keyFiles);
    const monorepoPackages = detectMonorepoPackages(fileTree, keyFiles);
    return {
        repoInfo,
        detectedStack,
        keyFiles,
        fileTree,
        totalFiles: fileTree.length,
        redactionSummary,
        ...(envVarInventory.length > 0 ? { envVarInventory } : {}),
        ...(Object.keys(dependencyUsage).length > 0 ? { dependencyUsage } : {}),
        ...(monorepoPackages.length > 0 ? { monorepoPackages } : {}),
    };
}
// ─── Org Dashboard Analyzer (enhancement #7) ─────────────────────────────────
function parseOrgUrl(url) {
    const cleaned = url.trim().replace(/\/$/, '');
    const match = cleaned.match(/https?:\/\/([\w.-]+)\/([\w.-]+)$/);
    if (!match) {
        throw new Error(`Invalid org URL: "${url}"\nExpected: https://github.com/myorg`);
    }
    return { hostname: match[1], org: match[2] };
}
async function analyzeOrg(orgUrl, token, onProgress) {
    const { hostname, org } = parseOrgUrl(orgUrl);
    onProgress(`Fetching repos for ${org}…`, 0, 1);
    // Fetch up to 100 repos (GitHub API default page size)
    const data = await githubGet(`/orgs/${org}/repos?per_page=100&sort=updated`, token, hostname)
        .catch(() => githubGet(`/users/${org}/repos?per_page=100&sort=updated`, token, hostname));
    const repos = [];
    const total = Math.min((data || []).length, 50); // cap at 50
    for (let i = 0; i < total; i++) {
        const r = data[i];
        onProgress(`Scanning ${r.name} (${i + 1}/${total})…`, i + 1, total);
        // Quick-fetch package.json or pom.xml to estimate stack
        let detectedStack = r.language || 'Unknown';
        let complexity = 'Unknown';
        try {
            const pkg = await fetchFileContent(r.owner.login, r.name, 'package.json', token, hostname);
            if (pkg) {
                const parsed = JSON.parse(pkg);
                const deps = { ...parsed.dependencies, ...parsed.devDependencies };
                if (deps['next']) {
                    detectedStack = 'Next.js';
                }
                else if (deps['react']) {
                    detectedStack = 'React';
                }
                else if (deps['vue']) {
                    detectedStack = 'Vue';
                }
                else if (deps['@angular/core']) {
                    detectedStack = 'Angular';
                }
                else if (deps['express']) {
                    detectedStack = 'Express';
                }
                else if (deps['@nestjs/core']) {
                    detectedStack = 'NestJS';
                }
                else {
                    detectedStack = 'Node.js';
                }
                const depCount = Object.keys(deps).length;
                complexity = depCount < 20 ? 'Low' : depCount < 60 ? 'Medium' : 'High';
            }
            else {
                const pom = await fetchFileContent(r.owner.login, r.name, 'pom.xml', token, hostname);
                if (pom) {
                    detectedStack = pom.includes('spring-boot') ? 'Spring Boot' : 'Java/Maven';
                    complexity = 'Medium';
                }
            }
        }
        catch { /* skip */ }
        repos.push({
            name: r.name,
            fullName: r.full_name,
            description: r.description || '',
            language: r.language || 'Unknown',
            stars: r.stargazers_count || 0,
            size: r.size || 0,
            defaultBranch: r.default_branch || 'main',
            updatedAt: r.updated_at || '',
            detectedStack,
            complexity,
        });
    }
    return { org, hostname, totalRepos: data.length, repos };
}
// ─── Branch Diff Fetcher (enhancement #8) ─────────────────────────────────────
async function fetchBranchDiff(owner, repo, baseBranch, compareBranch, token, hostname = 'github.com') {
    const data = await githubGet(`/repos/${owner}/${repo}/compare/${baseBranch}...${compareBranch}`, token, hostname);
    const changedFiles = (data.files || []).map((f) => f.filename);
    // Build a diff sample from the first few files
    const diffSample = (data.files || [])
        .slice(0, 5)
        .map((f) => `### ${f.filename}\n+${f.additions} -${f.deletions}\n${(f.patch || '').slice(0, 500)}`)
        .join('\n\n');
    return {
        baseBranch,
        compareBranch,
        changedFiles,
        additions: data.ahead_by || 0,
        deletions: data.behind_by || 0,
        diffSample: diffSample.slice(0, 6000),
    };
}
//# sourceMappingURL=githubAnalyzer.js.map