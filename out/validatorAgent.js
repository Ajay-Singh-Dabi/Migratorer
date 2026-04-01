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
exports.runTypeScriptValidation = runTypeScriptValidation;
exports.groupErrorsByFile = groupErrorsByFile;
exports.isTscAvailable = isTscAvailable;
const cp = __importStar(require("child_process"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
// ─── tsc error line parser ────────────────────────────────────────────────────
// Matches:  src/foo.ts(12,5): error TS2345: Argument of type ...
const TSC_ERROR_RE = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/;
function parseTscOutput(raw, localRepoPath) {
    const errors = [];
    for (const line of raw.split('\n')) {
        const m = line.match(TSC_ERROR_RE);
        if (!m) {
            continue;
        }
        // Normalise absolute path → repo-relative forward-slash path
        let filePath = m[1].trim();
        const abs = path.resolve(localRepoPath);
        if (filePath.startsWith(abs)) {
            filePath = filePath.slice(abs.length).replace(/^[\\/]/, '').replace(/\\/g, '/');
        }
        else {
            filePath = filePath.replace(/\\/g, '/');
        }
        errors.push({
            filePath,
            line: parseInt(m[2], 10),
            col: parseInt(m[3], 10),
            code: m[4],
            message: m[5].trim(),
        });
    }
    return errors;
}
// ─── Run TypeScript validation ─────────────────────────────────────────────────
/**
 * Runs `tsc --noEmit` in `localRepoPath`.
 * Looks for tsc in node_modules/.bin first, falls back to global npx tsc.
 */
function runTypeScriptValidation(localRepoPath, timeoutMs = 60000) {
    return new Promise(resolve => {
        // Prefer local tsc binary
        const localTsc = path.join(localRepoPath, 'node_modules', '.bin', 'tsc');
        const cmd = process.platform === 'win32'
            ? `"${localTsc}.cmd" --noEmit 2>&1 || npx tsc --noEmit 2>&1`
            : `"${localTsc}" --noEmit 2>&1 || npx tsc --noEmit 2>&1`;
        let timedOut = false;
        const proc = cp.exec(cmd, { cwd: localRepoPath, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 4 }, (err, stdout, stderr) => {
            if (timedOut) {
                return;
            }
            const raw = (stdout + stderr).trim();
            const errors = parseTscOutput(raw, localRepoPath);
            resolve({ success: errors.length === 0, errors, raw, timedOut: false });
        });
        setTimeout(() => {
            timedOut = true;
            proc.kill();
            resolve({ success: false, errors: [], raw: 'tsc timed out', timedOut: true });
        }, timeoutMs);
    });
}
// ─── Group errors by file ────────────────────────────────────────────────────
function groupErrorsByFile(errors) {
    const map = new Map();
    for (const e of errors) {
        if (!map.has(e.filePath)) {
            map.set(e.filePath, []);
        }
        map.get(e.filePath).push(e);
    }
    return map;
}
// ─── Check if tsc is available ────────────────────────────────────────────────
async function isTscAvailable(localRepoPath) {
    const localTscPath = vscode.Uri.file(path.join(localRepoPath, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'));
    try {
        await vscode.workspace.fs.stat(localTscPath);
        return true;
    }
    catch {
        // Try global
        return new Promise(resolve => {
            cp.exec('npx tsc --version', { timeout: 5000 }, (err) => resolve(!err));
        });
    }
}
//# sourceMappingURL=validatorAgent.js.map