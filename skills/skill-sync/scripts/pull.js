const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { execSync } = require('child_process');

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function loadConfiguration() {
    let config = {};
    try {
        const envPath = path.join(os.homedir(), '.agent-insight', '.env');
        const legacyEnvPath = path.join(os.homedir(), '.witty', '.env');
        const oldEnvPath = path.join(os.homedir(), '.skill-insight', '.env');
        const selectedEnvPath = fs.existsSync(envPath) ? envPath : (fs.existsSync(oldEnvPath) ? oldEnvPath : legacyEnvPath);
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
        host: config['SKILL_INSIGHT_HOST'] || config['WITTY_INSIGHT_HOST'] || process.env.SKILL_INSIGHT_HOST || process.env.WITTY_INSIGHT_HOST
    };
}

async function fetchManifest(host, apiKey) {
    const urlStr = host.match(/^https?:\/\//) ? host : `http://${host}`;
    const parsedUrl = new URL(urlStr + '/api/sync/manifest');
    const requestModule = parsedUrl.protocol === 'https:' ? https : http;

    const headers = {};
    if (apiKey) headers['x-witty-api-key'] = apiKey;

    return new Promise((resolve, reject) => {
        const req = requestModule.get(parsedUrl.href, { headers }, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`Failed to fetch manifest: ${res.statusCode}`));
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
    });
}

function downloadAndInstall(url, targetDir, apiKey) {
    const parsedUrl = new URL(url);
    const requestModule = parsedUrl.protocol === 'https:' ? https : http;
    const tempZip = path.join(os.tmpdir(), `witty_skill_${Date.now()}.zip`);

    const headers = {};
    if (apiKey) headers['x-witty-api-key'] = apiKey;

    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(tempZip);
        const req = requestModule.get(parsedUrl.href, { headers }, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`Download failed: ${res.statusCode}`));
                return;
            }
            res.pipe(file);
            file.on('finish', () => {
                file.close();
                try {
                    ensureDir(targetDir);
                    execSync(`unzip -o "${tempZip}" -d "${targetDir}"`, { stdio: 'ignore' });
                    fs.unlinkSync(tempZip);
                    resolve();
                } catch (e) {
                    fs.unlinkSync(tempZip);
                    reject(e);
                }
            });
        });
        req.on('error', err => {
            fs.unlinkSync(tempZip);
            reject(err);
        });
    });
}

async function main() {
    const targetSkillName = process.argv[2];
    const userTargetDir = process.argv[3];

    if (!targetSkillName) {
        console.error('⚠️  Error: Please provide the skill name to pull.');
        console.error('Usage: node scripts/pull.js <skill-name> [custom-target-dir]');
        process.exit(1);
    }

    const { host, apiKey } = loadConfiguration();
    if (!host) {
        console.error('⚠️  Error: Agent Insight Host is not configured.');
        console.error('Please configure SKILL_INSIGHT_HOST in ~/.agent-insight/.env');
        process.exit(1);
    }

    console.log(`🔍 Fetching skill catalog from ${host}...`);

    try {
        const manifest = await fetchManifest(host, apiKey);
        const remoteSkills = manifest.skills || [];

        const targetSkill = remoteSkills.find(s => s.name === targetSkillName);
        if (!targetSkill) {
            console.error(`\n❌ Skill '${targetSkillName}' not found on the platform.`);
            process.exit(1);
        }

        const outDir = userTargetDir ? path.resolve(userTargetDir) : path.join(process.cwd(), targetSkillName);
        
        console.log(`⬇️  Found skill '${targetSkill.name}' (v${targetSkill.version}). Downloading to ${outDir}...`);
        
        const urlStr = host.match(/^https?:\/\//) ? host : `http://${host}`;
        const downloadUrl = urlStr + targetSkill.downloadUrl;
        
        await downloadAndInstall(downloadUrl, outDir, apiKey);

        console.log(`\n✅ Successfully pulled skill to ${outDir}`);

    } catch (e) {
        console.error(`\n❌ Pull failed: ${e.message}`);
    }
}

main().catch(e => console.error(e));
