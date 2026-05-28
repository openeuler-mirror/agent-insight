const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const readline = require('readline');

// 1. Load configuration
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
        host: config['SKILL_INSIGHT_HOST'] || config['WITTY_INSIGHT_HOST'] || process.env.SKILL_INSIGHT_HOST || process.env.WITTY_INSIGHT_HOST,
        user: config['SKILL_INSIGHT_USER'] || config['WITTY_INSIGHT_USER'] || process.env.SKILL_INSIGHT_USER || process.env.WITTY_INSIGHT_USER
    };
}

// 2. Build multipart body
const boundary = '----WittyFormBoundary' + Math.random().toString(36).substring(2);
let bodySegments = [];

function appendFile(fieldname, filepath, relativePath) {
    const filename = relativePath;
    const content = fs.readFileSync(filepath);
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="${fieldname}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    bodySegments.push(Buffer.from(header, 'utf8'));
    bodySegments.push(content);
    bodySegments.push(Buffer.from('\r\n', 'utf8'));
}

function appendField(fieldname, value) {
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="${fieldname}"\r\n\r\n${value}\r\n`;
    bodySegments.push(Buffer.from(header, 'utf8'));
}

async function main() {
    const targetPath = process.argv[2];
    if (!targetPath) {
        console.error('⚠️  Error: Please provide the local skill folder path.');
        console.error('Usage: node scripts/push.js <path-to-skill>');
        process.exit(1);
    }
    
    const absPath = path.resolve(targetPath);
    if (!fs.existsSync(absPath)) {
        console.error(`⚠️  Error: The directory ${absPath} does not exist.`);
        process.exit(1);
    }
    
    const skillMdPath = path.join(absPath, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
        console.error('⚠️  Error: Missing SKILL.md. A valid skill folder must contain a SKILL.md file at its root.');
        process.exit(1);
    }
    
    // Parse name from SKILL.md locally to check version
    const folderName = path.basename(absPath);
    let extractedName = folderName;
    const skillContent = fs.readFileSync(skillMdPath, 'utf8');
    const match = skillContent.match(/^---\s*([\s\S]*?)\s*---/);
    if (match && match[1]) {
        const nameMatch = match[1].match(/^name:\s*(.+)$/m);
        if (nameMatch && nameMatch[1]) {
            extractedName = nameMatch[1].trim();
        }
    }

    const { host, apiKey, user } = loadConfiguration();
    if (!host) {
        console.error('⚠️  Error: Agent Insight Host is not configured.');
        console.error('Please configure SKILL_INSIGHT_HOST in ~/.agent-insight/.env');
        process.exit(1);
    }

    // Checking existence on Insight platform
    const urlStr = host.match(/^https?:\/\//) ? host : `http://${host}`;
    const checkUrl = new URL(urlStr + '/api/skills' + (user ? `?user=${encodeURIComponent(user)}` : ''));
    
    const checkReqModule = checkUrl.protocol === 'https:' ? https : http;
    const existingSkill = await new Promise((resolve) => {
        const options = { method: 'GET', headers: {} };
        if (apiKey) options.headers['x-witty-api-key'] = apiKey;
        
        const req = checkReqModule.request(checkUrl, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        const skills = JSON.parse(data);
                        const existing = skills.find(s => s.name === extractedName);
                        resolve(existing);
                    } catch(e) { resolve(null); }
                } else {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.end();
    });

    let targetVersionNum = 0;
    if (existingSkill) {
        let maxVersion = -1;
        if (existingSkill.versions && existingSkill.versions.length > 0) {
            maxVersion = Math.max(...existingSkill.versions.map(v => v.version));
        }
        targetVersionNum = maxVersion + 1;
        console.log(`\nℹ️  Insight平台已存在该Skill (名称: ${extractedName})。`);
        console.log(`ℹ️  本次操作将以新版本 v${targetVersionNum} 上传。`);
    } else {
        console.log(`\nℹ️  Insight平台未找到同名Skill (名称: ${extractedName})。`);
        console.log(`ℹ️  本次操作将以首个版本 v0 上传。`);
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const confirm = await new Promise(resolve => {
        rl.question(`❓ 是否确认上传? (y/N) `, answer => {
            rl.close();
            resolve(answer.trim().toLowerCase() === 'y');
        });
    });

    if (!confirm) {
        console.log('❌ 已取消上传。');
        process.exit(0);
    }

    // append user field if exists
    if (user) {
        appendField('user', user);
    }
    
    // append targetSkillId if the skill already exists
    if (existingSkill && existingSkill.id) {
        appendField('targetSkillId', existingSkill.id);
    }

    // walk dir and add files
    function walkDir(dir) {
        fs.readdirSync(dir).forEach(file => {
            const fullPath = path.join(dir, file);
            if (fs.statSync(fullPath).isDirectory()) {
                walkDir(fullPath);
            } else {
                // compute relative path preserving the root folder name.
                const rootName = path.basename(absPath);
                const relPath = path.relative(absPath, fullPath);
                const webkitRelativePath = path.posix.join(rootName, relPath.split(path.sep).join(path.posix.sep));
                
                appendFile('files', fullPath, webkitRelativePath);
                appendField('paths', webkitRelativePath);
            }
        });
    }

    console.log(`📦 Packaging skill at ${absPath}...`);
    walkDir(absPath);
    
    bodySegments.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
    const fullBody = Buffer.concat(bodySegments);

    const targetUrl = new URL(urlStr + '/api/skills/upload');

    console.log(`🚀 Uploading to ${targetUrl.href}...`);

    const options = {
        method: 'POST',
        headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': fullBody.length
        }
    };
    if (apiKey) {
        options.headers['x-witty-api-key'] = apiKey;
    }

    const requestModule = targetUrl.protocol === 'https:' ? https : http;

    const req = requestModule.request(targetUrl, options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
                try {
                    const result = JSON.parse(data);
                    console.log(`\n✅ Upload successful!`);
                    console.log(`-> Skill: ${result.skill?.name || 'Unknown'}`);
                    console.log(`-> Version: v${result.version?.version || 0}`);
                } catch {
                    console.log(`\n✅ Upload successful! Server response: ${data}`);
                }
            } else {
                console.error(`\n❌ Upload failed! Status: ${res.statusCode}`);
                try {
                    const result = JSON.parse(data);
                    console.error(`-> Error: ${result.error}`);
                } catch {
                    console.error(`-> Error response: ${data}`);
                }
            }
        });
    });

    req.on('error', (e) => {
        console.error(`\n❌ Network error while uploading: ${e.message}`);
    });

    req.write(fullBody);
    req.end();
}

main().catch(e => console.error(e));
