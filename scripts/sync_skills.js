"use strict";
/**
 * Agent-Insight Skill Synchronizer
 *
 * Fetches configured skills from Dashboard and installs them locally.
 * Usage: node sync_skills.js [--check-only] [--agent <name>]
 *
 * Requires: ~/.agent-insight/.env configuration
 */
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
const fs = __importStar(require("fs"));
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const AGENTS_DIR_MAP = {
    "opencode": ".opencode/skills",
    "openhands": ".openhands/skills",
    "claude": ".claude/skills",
    "deepagents": ".deepagents/skills"
};
function loadConfiguration() {
    let config = {};
    try {
        for (const envPath of [path.join(os.homedir(), '.agent-insight', '.env'), path.join(os.homedir(), '.skill-insight', '.env')]) {
            if (!fs.existsSync(envPath)) continue;
            const content = fs.readFileSync(envPath, 'utf8');
            content.split('\n').forEach(line => {
                const match = line.match(/^\s*([\w_]+)\s*=\s*(.*)?\s*$/);
                if (match && match[1]) {
                    config[match[1]] = (match[2] || '').trim().replace(/^['"](.*)['"]$/, '$1');
                }
            });
        }
    }
    catch (e) { }
    return {
        apiKey: config['AGENT_INSIGHT_API_KEY'] || process.env.AGENT_INSIGHT_API_KEY,
        host: config['AGENT_INSIGHT_HOST'] || process.env.AGENT_INSIGHT_HOST || '127.0.0.1:3000'
    };
}
async function fetchManifest(host) {
    const urlStr = host.match(/^https?:\/\//) ? host : `http://${host}`;
    const parsedUrl = new URL(urlStr);
    const requestModule = parsedUrl.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const req = requestModule.get(`${urlStr}/api/sync/manifest`, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`Failed to fetch manifest: ${res.statusCode}`));
                return;
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                }
                catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
    });
}
function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}
// Simple unzip implementation using zlib if available or just raw write if not zipped
// Note: This is a placeholder. Real implementations use 'adm-zip' or 'unzip' command.
// For simplicity in a script without dependencies, we'll assume the /download endpoint returns raw content for single file
// or we use system unzip command.
async function downloadAndInstall(host, downloadPath, targetDir) {
    const urlStr = host.match(/^https?:\/\//) ? host : `http://${host}`;
    const parsedUrl = new URL(urlStr + downloadPath);
    const requestModule = parsedUrl.protocol === 'https:' ? https : http;
    // Use system curl/unzip if available for robustness
    const tempZip = path.join(os.tmpdir(), `witty_skill_${Date.now()}.zip`);
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(tempZip);
        const req = requestModule.get(parsedUrl.href, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`Download failed: ${res.statusCode}`));
                return;
            }
            res.pipe(file);
            file.on('finish', () => {
                file.close();
                // Unzip
                try {
                    // Try unzip command
                    const { execSync } = require('child_process');
                    ensureDir(targetDir);
                    // Clear target first? Maybe dangerous. Better overwrite.
                    execSync(`unzip -o "${tempZip}" -d "${targetDir}"`, { stdio: 'ignore' });
                    fs.unlinkSync(tempZip);
                    resolve();
                }
                catch (e) {
                    // Fallback or error
                    fs.unlinkSync(tempZip);
                    reject(e);
                }
            });
        });
        req.on('error', (err) => {
            fs.unlinkSync(tempZip);
            reject(err);
        });
    });
}
async function syncSkills(targetAgent) {
    const { host } = loadConfiguration();
    console.log(`🔄 Checking for skill updates from ${host}...`);
    try {
        const manifest = await fetchManifest(host);
        const remoteSkills = manifest.skills || [];
        if (remoteSkills.length === 0) {
            console.log("✓ No skills configured on dashboard.");
            return;
        }
        const agents = targetAgent ? [targetAgent] : Object.keys(AGENTS_DIR_MAP);
        let updatedCount = 0;
        for (const agent of agents) {
            const relativePath = AGENTS_DIR_MAP[agent];
            if (!relativePath)
                continue;
            // Resolve path relative to CWD (where user runs command)
            // OR relative to HOME? Standard is usually project root or HOME based on agent.
            // For global tools like OpenCode/Claude, it's usually ~/.opencode/skills
            // But AGENTS_DIR_MAP keys start with .
            // Let's assume paths are relative to CWD (Current Working Directory)
            // This prevents polluting global ~/.opencode, allowing project-specific skills
            const skillsDir = path.join(process.cwd(), relativePath);
            const manifestPath = path.join(skillsDir, 'manifest.json');
            let localManifest = {};
            try {
                if (fs.existsSync(manifestPath)) {
                    localManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                }
            }
            catch (e) { }
            for (const skill of remoteSkills) {
                const localVer = localManifest[skill.name]?.version || -1;
                if (skill.version > localVer) {
                    console.log(`⬇️  [${agent}] Updating ${skill.name} (v${localVer} -> v${skill.version})...`);
                    const targetSkillDir = path.join(skillsDir, skill.name);
                    try {
                        await downloadAndInstall(host, skill.downloadUrl, targetSkillDir);
                        localManifest[skill.name] = {
                            version: skill.version,
                            updatedAt: new Date().toISOString()
                        };
                        updatedCount++;
                    }
                    catch (e) {
                        console.error(`❌ Failed to update ${skill.name}:`, e);
                    }
                }
            }
            if (updatedCount > 0) {
                ensureDir(skillsDir);
                fs.writeFileSync(manifestPath, JSON.stringify(localManifest, null, 2));
            }
        }
        if (updatedCount > 0) {
            console.log(`✅ Synced ${updatedCount} skills.`);
        }
        else {
            console.log("✓ All skills up to date.");
        }
    }
    catch (e) {
        console.error("⚠️  Skill sync failed (Dashboard offline?):", e.message);
    }
}
// Run
const args = process.argv.slice(2);
const agentArgIndex = args.indexOf('--agent');
const targetAgent = agentArgIndex !== -1 ? args[agentArgIndex + 1] : undefined;
syncSkills(targetAgent);
