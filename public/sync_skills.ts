/**
 * Witty-Skill-Insight Skill Synchronizer
 * 
 * Fetches configured skills from Dashboard and installs them locally.
 * Usage: node sync_skills.js [--check-only] [--agent <name>]
 * 
 * Requires: ~/.skill-insight/.env or ~/.witty/.env configuration
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';

const AGENTS_DIR_MAP: Record<string, string> = {
    "opencode": ".opencode/skills",
    "openhands": ".openhands/skills", 
    "claude": ".claude/skills",
    "deepagents": ".deepagents/skills"
};

interface Config {
    apiKey?: string;
    host: string;
}

function loadConfiguration(): Config {
    let config: Record<string, string> = {};
    try {
        const envPath = path.join(os.homedir(), '.skill-insight', '.env');
        const legacyEnvPath = path.join(os.homedir(), '.witty', '.env');
        const selectedEnvPath = fs.existsSync(envPath) ? envPath : legacyEnvPath;
        
        if (fs.existsSync(selectedEnvPath)) {
            const content = fs.readFileSync(selectedEnvPath, 'utf8');
            content.split('\n').forEach(line => {
                const match = line.match(/^\s*([\w_]+)\s*=\s*(.*)?\s*$/);
                if (match && match[1]) {
                    config[match[1]] = (match[2] || '').trim().replace(/^['"](.*)['"]$/, '$1');
                }
            });
        }
    } catch (e) {}
    
    return {
        apiKey: config['SKILL_INSIGHT_API_KEY'] || config['WITTY_INSIGHT_API_KEY'] || process.env.SKILL_INSIGHT_API_KEY || process.env.WITTY_INSIGHT_API_KEY,
        host: config['SKILL_INSIGHT_HOST'] || config['WITTY_INSIGHT_HOST'] || process.env.SKILL_INSIGHT_HOST || process.env.WITTY_INSIGHT_HOST || '127.0.0.1:3000'
    };
}

async function fetchManifest(host: string, apiKey?: string): Promise<any> {
    const urlStr = host.match(/^https?:\/\//) ? host : `http://${host}`;
    const parsedUrl = new URL(`${urlStr}/api/sync/manifest`);
    const requestModule = parsedUrl.protocol === 'https:' ? https : http;

    const headers: Record<string, string> = {};
    if (apiKey) {
        headers['x-witty-api-key'] = apiKey;
    }
    
    return new Promise((resolve, reject) => {
        const req = requestModule.get(parsedUrl.href, { headers }, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`Failed to fetch manifest: ${res.statusCode}`));
                return;
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
    });
}

function ensureDir(dirPath: string) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

// Simple unzip implementation using zlib if available or just raw write if not zipped
// Note: This is a placeholder. Real implementations use 'adm-zip' or 'unzip' command.
// For simplicity in a script without dependencies, we'll assume the /download endpoint returns raw content for single file
// or we use system unzip command.

async function downloadAndInstall(host: string, downloadPath: string, targetDir: string, apiKey?: string) {
    const urlStr = host.match(/^https?:\/\//) ? host : `http://${host}`;
    const parsedUrl = new URL(urlStr + downloadPath);
    const requestModule = parsedUrl.protocol === 'https:' ? https : http;

    const headers: Record<string, string> = {};
    if (apiKey) {
        headers['x-witty-api-key'] = apiKey;
    }

    // Use system curl/unzip if available for robustness
    const tempZip = path.join(os.tmpdir(), `witty_skill_${Date.now()}.zip`);
    
    return new Promise<void>((resolve, reject) => {
        const file = fs.createWriteStream(tempZip);
        const req = requestModule.get(parsedUrl.href, { headers }, (res) => {
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
                    ensureDir(targetDir);
                    execSync(`unzip -o "${tempZip}" -d "${targetDir}"`, { stdio: 'ignore' });
                    fs.unlinkSync(tempZip);
                    resolve();
                } catch (e) {
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

async function syncSkills(targetAgent?: string) {
    const { host, apiKey } = loadConfiguration();
    console.log(`🔄 Checking for skill updates from ${host}...`);
    if (apiKey) {
        console.log(`🔑 Using API Key for user-specific skill sync.`);
    }

    try {
        const manifest = await fetchManifest(host, apiKey);
        const remoteSkills = manifest.skills || [];
        
        if (remoteSkills.length === 0) {
            console.log("✓ No skills configured on dashboard.");
            return;
        }

        const agents = targetAgent ? [targetAgent] : Object.keys(AGENTS_DIR_MAP);
        let updatedCount = 0;

        for (const agent of agents) {
            const relativePath = AGENTS_DIR_MAP[agent];
            if (!relativePath) continue;

            // Resolve path relative to CWD (where user runs command)
            // OR relative to HOME? Standard is usually project root or HOME based on agent.
            // For global tools like OpenCode/Claude, it's usually ~/.opencode/skills
            // But AGENTS_DIR_MAP keys start with .
            
            // Let's assume paths are relative to CWD (Current Working Directory)
            // This prevents polluting global ~/.opencode, allowing project-specific skills
            const skillsDir = path.join(process.cwd(), relativePath);
            const manifestPath = path.join(skillsDir, 'manifest.json');
            
            let localManifest: Record<string, any> = {};
            try {
                if (fs.existsSync(manifestPath)) {
                    localManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                }
            } catch (e) {}

            for (const skill of remoteSkills) {
                const localVer = localManifest[skill.name]?.version || -1;
                if (skill.version > localVer) {
                    console.log(`⬇️  [${agent}] Updating ${skill.name} (v${localVer} -> v${skill.version})...`);
                    const targetSkillDir = path.join(skillsDir, skill.name);
                    
                    try {
                        await downloadAndInstall(host, skill.downloadUrl, targetSkillDir, apiKey);
                        localManifest[skill.name] = { 
                            version: skill.version,
                            updatedAt: new Date().toISOString()
                        };
                        updatedCount++;
                    } catch (e) {
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
        } else {
            console.log("✓ All skills up to date.");
        }

    } catch (e) {
        console.error("⚠️  Skill sync failed (Dashboard offline?):", (e as Error).message);
    }
}

// Run
const args = process.argv.slice(2);
const agentArgIndex = args.indexOf('--agent');
const targetAgent = agentArgIndex !== -1 ? args[agentArgIndex + 1] : undefined;

syncSkills(targetAgent);
