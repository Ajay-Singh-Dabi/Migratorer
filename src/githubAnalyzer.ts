import * as https from 'https';
import * as vscode from 'vscode';
import {
  RepoInfo,
  KeyFile,
  DetectedStack,
  RepoAnalysis,
} from './types';

// ─── GitHub API Helper ────────────────────────────────────────────────────────

function githubGet(path: string, token?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = {
      hostname: 'api.github.com',
      path,
      method: 'GET',
      headers: {
        'User-Agent': 'vscode-migration-assistant/1.0',
        'Accept': 'application/vnd.github+json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode === 404) {
          reject(new Error(`Repository not found or not accessible (404). If it's private, provide a GitHub token.`));
          return;
        }
        if (res.statusCode === 403) {
          reject(new Error(`GitHub API rate limit exceeded (403). Provide a GitHub token to increase limits.`));
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`GitHub API error: ${res.statusCode} - ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Failed to parse GitHub API response`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('GitHub API request timed out'));
    });
    req.end();
  });
}

// ─── URL Parser ───────────────────────────────────────────────────────────────

export function parseGitHubUrl(url: string): { owner: string; repo: string } {
  const cleaned = url.trim()
    .replace(/\.git$/, '')
    .replace(/\/$/, '');

  const match = cleaned.match(/github\.com[/:]([\w.-]+)\/([\w.-]+)/);
  if (!match) {
    throw new Error(`Invalid GitHub URL: "${url}"\nExpected format: https://github.com/owner/repo`);
  }
  return { owner: match[1], repo: match[2] };
}

// ─── Fetch Repo Info ──────────────────────────────────────────────────────────

async function fetchRepoInfo(owner: string, repo: string, token?: string): Promise<RepoInfo> {
  const data = await githubGet(`/repos/${owner}/${repo}`, token);
  return {
    owner,
    repo,
    defaultBranch: data.default_branch || 'main',
    description: data.description || '',
    language: data.language || 'Unknown',
    stars: data.stargazers_count || 0,
    size: data.size || 0,
  };
}

// ─── Fetch File Tree ──────────────────────────────────────────────────────────

async function fetchFileTree(owner: string, repo: string, branch: string, token?: string): Promise<string[]> {
  try {
    const data = await githubGet(
      `/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
      token
    );
    if (data.truncated) {
      vscode.window.showWarningMessage('Repository is very large — file tree is truncated.');
    }
    return (data.tree || [])
      .filter((item: any) => item.type === 'blob')
      .map((item: any) => item.path as string);
  } catch {
    // Fallback: get root contents
    const items = await githubGet(`/repos/${owner}/${repo}/contents`, token);
    return (items || []).map((item: any) => item.path as string);
  }
}

// ─── Fetch File Content ───────────────────────────────────────────────────────

async function fetchFileContent(
  owner: string,
  repo: string,
  path: string,
  token?: string
): Promise<string | null> {
  try {
    const data = await githubGet(`/repos/${owner}/${repo}/contents/${path}`, token);
    if (data.content && data.encoding === 'base64') {
      return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf-8');
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Key Files to Detect ─────────────────────────────────────────────────────

const KEY_FILE_PATTERNS: Array<{ path: string; type: KeyFile['type'] }> = [
  // JavaScript / Node
  { path: 'package.json', type: 'package-manager' },
  { path: 'yarn.lock', type: 'package-manager' },
  { path: 'pnpm-lock.yaml', type: 'package-manager' },
  // Python
  { path: 'requirements.txt', type: 'package-manager' },
  { path: 'pyproject.toml', type: 'package-manager' },
  { path: 'setup.py', type: 'package-manager' },
  { path: 'Pipfile', type: 'package-manager' },
  // Java
  { path: 'pom.xml', type: 'build-tool' },
  { path: 'build.gradle', type: 'build-tool' },
  { path: 'build.gradle.kts', type: 'build-tool' },
  { path: 'gradle.properties', type: 'config' },
  // .NET
  { path: 'global.json', type: 'config' },
  // Go
  { path: 'go.mod', type: 'package-manager' },
  { path: 'go.sum', type: 'package-manager' },
  // Rust
  { path: 'Cargo.toml', type: 'package-manager' },
  // Ruby
  { path: 'Gemfile', type: 'package-manager' },
  { path: 'Gemfile.lock', type: 'package-manager' },
  // PHP
  { path: 'composer.json', type: 'package-manager' },
  // Config files
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
  // Readme
  { path: 'README.md', type: 'readme' },
];

// ─── Stack Detection ──────────────────────────────────────────────────────────

function detectStack(keyFiles: KeyFile[], fileTree: string[], repoLanguage: string): DetectedStack {
  const stack: DetectedStack = {
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

  // CI
  if (fileMap.has('.github/workflows/main.yml') || fileMap.has('.github/workflows/ci.yml')) {
    stack.ciSystem = 'GitHub Actions';
  } else if (fileMap.has('.travis.yml')) {
    stack.ciSystem = 'Travis CI';
  } else if (fileMap.has('Jenkinsfile')) {
    stack.ciSystem = 'Jenkins';
  } else if (fileMap.has('.circleci/config.yml')) {
    stack.ciSystem = 'CircleCI';
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
      } else if (fileMap.has('.nvmrc')) {
        const ver = fileMap.get('.nvmrc')?.trim();
        stack.runtime = `Node.js ${ver}`;
        stack.currentVersion = `Node.js ${ver}`;
      } else {
        stack.runtime = 'Node.js (version unspecified)';
      }

      // Detect framework
      const deps = { ...stack.dependencies, ...stack.devDependencies };
      if (deps['next']) { stack.framework = `Next.js ${deps['next']}`; }
      else if (deps['nuxt'] || deps['nuxt3']) { stack.framework = `Nuxt ${deps['nuxt'] || deps['nuxt3']}`; }
      else if (deps['@angular/core']) { stack.framework = `Angular ${deps['@angular/core']}`; }
      else if (deps['react']) { stack.framework = `React ${deps['react']}`; }
      else if (deps['vue']) { stack.framework = `Vue ${deps['vue']}`; }
      else if (deps['svelte']) { stack.framework = `Svelte ${deps['svelte']}`; }
      else if (deps['express']) { stack.framework = `Express ${deps['express']}`; }
      else if (deps['fastify']) { stack.framework = `Fastify ${deps['fastify']}`; }
      else if (deps['@nestjs/core']) { stack.framework = `NestJS ${deps['@nestjs/core']}`; }
      else if (deps['koa']) { stack.framework = `Koa ${deps['koa']}`; }

      // Testing
      if (deps['jest'] || deps['@jest/core']) { stack.testingFrameworks.push('Jest'); }
      if (deps['vitest']) { stack.testingFrameworks.push('Vitest'); }
      if (deps['mocha']) { stack.testingFrameworks.push('Mocha'); }
      if (deps['cypress']) { stack.testingFrameworks.push('Cypress'); }
      if (deps['playwright'] || deps['@playwright/test']) { stack.testingFrameworks.push('Playwright'); }

      // Databases
      if (deps['mongoose'] || deps['mongodb']) { stack.databases.push('MongoDB'); }
      if (deps['pg'] || deps['postgres']) { stack.databases.push('PostgreSQL'); }
      if (deps['mysql'] || deps['mysql2']) { stack.databases.push('MySQL'); }
      if (deps['redis'] || deps['ioredis']) { stack.databases.push('Redis'); }
      if (deps['prisma'] || deps['@prisma/client']) { stack.databases.push('Prisma ORM'); }
      if (deps['typeorm']) { stack.databases.push('TypeORM'); }
      if (deps['sequelize']) { stack.databases.push('Sequelize ORM'); }
      if (deps['drizzle-orm']) { stack.databases.push('Drizzle ORM'); }

    } catch { /* ignore parse errors */ }
  }

  // Python
  const reqTxt = fileMap.get('requirements.txt') || fileMap.get('Pipfile');
  const pyprojectToml = fileMap.get('pyproject.toml');
  if (reqTxt || pyprojectToml) {
    stack.primaryLanguage = 'Python';
    stack.packageManager = fileMap.has('Pipfile') ? 'Pipenv' : fileMap.has('pyproject.toml') ? 'Poetry/pip' : 'pip';
    const src = reqTxt || pyprojectToml || '';
    if (src.includes('django')) { stack.framework = 'Django'; }
    else if (src.includes('flask')) { stack.framework = 'Flask'; }
    else if (src.includes('fastapi')) { stack.framework = 'FastAPI'; }
    else if (src.includes('tornado')) { stack.framework = 'Tornado'; }
    if (src.includes('pytest')) { stack.testingFrameworks.push('pytest'); }
    if (src.includes('unittest')) { stack.testingFrameworks.push('unittest'); }
    const pyVer = fileMap.get('.python-version');
    if (pyVer) {
      stack.runtime = `Python ${pyVer.trim()}`;
      stack.currentVersion = `Python ${pyVer.trim()}`;
    } else {
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
    if (src.includes('spring-boot') || src.includes('spring-boot-starter')) { stack.framework = 'Spring Boot'; }
    else if (src.includes('quarkus')) { stack.framework = 'Quarkus'; }
    else if (src.includes('micronaut')) { stack.framework = 'Micronaut'; }

    // Detect Java version from pom.xml
    const javaVerMatch = src.match(/<java\.version>([\d.]+)<\/java\.version>/) ||
      src.match(/sourceCompatibility\s*=\s*['"]?([\d.]+)/) ||
      src.match(/javaVersion\s*=\s*['"]?([\d.]+)/);
    if (javaVerMatch) {
      stack.runtime = `Java ${javaVerMatch[1]}`;
      stack.currentVersion = `Java ${javaVerMatch[1]}`;
    } else {
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
    if (goMod.includes('gin-gonic/gin')) { stack.framework = 'Gin'; }
    else if (goMod.includes('labstack/echo')) { stack.framework = 'Echo'; }
    else if (goMod.includes('gorilla/mux')) { stack.framework = 'Gorilla Mux'; }
    else if (goMod.includes('go-chi/chi')) { stack.framework = 'Chi'; }
  }

  // Rust
  const cargoToml = fileMap.get('Cargo.toml');
  if (cargoToml) {
    stack.primaryLanguage = 'Rust';
    stack.packageManager = 'Cargo';
    stack.buildTool = 'cargo build';
    if (cargoToml.includes('actix-web')) { stack.framework = 'Actix Web'; }
    else if (cargoToml.includes('axum')) { stack.framework = 'Axum'; }
    else if (cargoToml.includes('rocket')) { stack.framework = 'Rocket'; }
  }

  return stack;
}

// ─── Main Analyzer ────────────────────────────────────────────────────────────

export async function analyzeRepository(
  repoUrl: string,
  token: string | undefined,
  onProgress: (msg: string, step: number, total: number) => void
): Promise<RepoAnalysis> {
  const STEPS = 4;

  onProgress('Parsing repository URL…', 1, STEPS);
  const { owner, repo } = parseGitHubUrl(repoUrl);

  onProgress(`Fetching repository info for ${owner}/${repo}…`, 2, STEPS);
  const repoInfo = await fetchRepoInfo(owner, repo, token);

  onProgress('Loading file tree…', 3, STEPS);
  const fileTree = await fetchFileTree(owner, repo, repoInfo.defaultBranch, token);

  onProgress('Reading key configuration files…', 4, STEPS);

  // Find which key files exist in this repo
  const existingKeyFiles = KEY_FILE_PATTERNS.filter(
    (kf) => fileTree.includes(kf.path)
  );

  // Also find CI workflows
  const ciWorkflows = fileTree.filter((f) =>
    f.startsWith('.github/workflows/') && f.endsWith('.yml')
  ).slice(0, 2);

  const allToFetch = [
    ...existingKeyFiles,
    ...ciWorkflows
      .filter((p) => !existingKeyFiles.some((kf) => kf.path === p))
      .map((p) => ({ path: p, type: 'ci' as KeyFile['type'] })),
  ];

  const keyFiles: KeyFile[] = (
    await Promise.all(
      allToFetch.map(async ({ path, type }) => {
        const content = await fetchFileContent(owner, repo, path, token);
        if (!content) { return null; }
        // Truncate very large files
        return {
          path,
          type,
          content: content.length > 8000 ? content.slice(0, 8000) + '\n... (truncated)' : content,
        } as KeyFile;
      })
    )
  ).filter((f): f is KeyFile => f !== null);

  const detectedStack = detectStack(keyFiles, fileTree, repoInfo.language);

  return {
    repoInfo,
    detectedStack,
    keyFiles,
    fileTree,
    totalFiles: fileTree.length,
  };
}
