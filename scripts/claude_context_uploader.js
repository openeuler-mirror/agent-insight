#!/usr/bin/env node
'use strict';

/**
 * Claude Code 上下文补传器(客户端)。
 *
 * 背景:官方 OTel logs 拿不到两样东西 ——
 *   1. system prompt:只在 Messages 请求体顶层 `system` 里。`OTEL_LOG_RAW_API_BODIES=file:<dir>`
 *      模式下事件只带 `body_ref`(本机绝对路径),服务端与客户端不同机时永远读不到;
 *      inline 模式实测有 ~60KB 硬截断,JSON 不完整照样解析不出。
 *   2. hook 注入的 additionalContext:压根不进 OTel 事件,只落在本机会话 transcript。
 *   3. 工具输出:tool_result 事件通常只给 metadata / 大小,正文要回读请求体 —— 同样跨机拿不到。
 *      顺带解决子 agent:Task 调用的输出补上后,服务端就能重建出子 agent 节点。
 * 三者都只存在于【客户端本机磁盘】,所以由本脚本在会话结束时捞出来发给平台。
 *
 * 用法:
 *   node claude_context_uploader.js              # 作为 Claude Code hook 运行(从 stdin 读 hook 负载)
 *   node claude_context_uploader.js --install-hook  # 幂等地把自己注册进 ~/.claude/settings.json
 *   node claude_context_uploader.js --uninstall-hook
 *   echo '{"session_id":"…","transcript_path":"…"}' | node claude_context_uploader.js --dry-run
 *                                               # 只打印会上传什么(不发请求、不写 checkpoint),排障用
 *
 * 设计约束:
 *   - 绝不影响会话:任何异常都吞掉并 exit(0),hook 失败不该让用户的 claude 报错。
 *   - 有界:扫描的文件数、单条长度、条数、读取字节数全部封顶,长会话不会把内存/CPU 打爆。
 *   - 幂等:按内容 hash 去重,checkpoint 按 API key 隔离(避免多账号串数据)。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const readline = require('readline');

const HOME = os.homedir();
const BASE_DIR = path.join(HOME, '.agent-insight');
const ENV_FILE = path.join(BASE_DIR, '.env');
const CLAUDE_SETTINGS = path.join(HOME, '.claude', 'settings.json');

// —— 有界扫描的上限(都可用环境变量覆盖)——
const LIMITS = {
  rawBodyFiles: 40,          // 最多解析多少个 request.json(按 mtime 新→旧)
  rawBodyBytes: 8 * 1024 * 1024,
  systemPrompts: 3,          // 一个会话最多传几份不同的 system prompt
  hookItems: 50,
  toolOutputs: 200,          // 一个会话最多传几条工具输出
  toolOutputChars: 4000,     // 单条工具输出上限(和 AGENT_INSIGHT_MAX_TOOL_IO 同口径)
  subagentMaps: 30,          // 一个会话最多传几个子 agent 的归属映射
  subagentMapIds: 400,       // 单个映射里 uuid / tool_use_id 各自的条数上限
  subagentFileBytes: 16 * 1024 * 1024,
  textChars: 64000,
  transcriptBytes: 64 * 1024 * 1024,
  requestTimeoutMs: 10000,
  uploadBatchSize: 100,      // 服务端单次最多收 200 条,这里分批发,避免被截断丢数据
  checkpointSessions: 200,
};

function log(msg) {
  if (!process.env.AGENT_INSIGHT_DEBUG) return;
  try {
    const dir = path.join(BASE_DIR, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'claude_context_uploader.log'), `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

function readEnvFile() {
  const env = {};
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch {}
  return env;
}

function conf(env, name, fallback) {
  const value = process.env[name] !== undefined ? process.env[name] : env[name];
  return value === undefined || value === '' ? fallback : value;
}

function isOff(value) {
  return String(value).toLowerCase() === 'false' || String(value) === '0';
}

function numberConf(env, name, fallback) {
  const parsed = Number(conf(env, name, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeHost(raw) {
  let host = String(raw || '').trim() || 'http://127.0.0.1:3000';
  if (!/^https?:\/\//i.test(host)) host = `http://${host}`;
  return host.replace(/\/+$/, '');
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function readStdin(timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const done = (value) => { clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => done(data), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => done(data));
    process.stdin.on('error', () => done(data));
  });
}

/** raw body 的 metadata.user_id 是一段 JSON 字符串,里面带 session_id —— 用它精确归属,不靠 mtime 猜。 */
function sessionIdOfBody(body) {
  try {
    const raw = body && body.metadata && body.metadata.user_id;
    if (typeof raw !== 'string') return '';
    const parsed = JSON.parse(raw);
    return typeof parsed.session_id === 'string' ? parsed.session_id : '';
  } catch {
    return '';
  }
}

function flattenSystem(system) {
  if (!system) return '';
  if (typeof system === 'string') return system.trim();
  if (Array.isArray(system)) {
    return system
      .map((block) => (typeof block === 'string' ? block : block && typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (typeof system === 'object' && typeof system.text === 'string') return system.text.trim();
  return '';
}

function collectSystemPrompts(rawBodyDir, sessionId, limits) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(rawBodyDir).filter((name) => name.endsWith('.request.json'));
  } catch {
    return out;
  }

  const stats = [];
  for (const name of entries) {
    const full = path.join(rawBodyDir, name);
    try {
      const stat = fs.statSync(full);
      if (stat.size > limits.rawBodyBytes) continue;
      stats.push({ full, mtimeMs: stat.mtimeMs });
    } catch {}
  }
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const seen = new Set();
  let scanned = 0;
  for (const entry of stats) {
    if (scanned >= limits.rawBodyFiles || out.length >= limits.systemPrompts) break;
    scanned += 1;
    let body;
    try {
      body = JSON.parse(fs.readFileSync(entry.full, 'utf8'));
    } catch {
      continue;
    }
    if (sessionIdOfBody(body) !== sessionId) continue;
    const text = flattenSystem(body.system);
    if (!text) continue;
    const hash = sha256(text);
    if (seen.has(hash)) continue;
    seen.add(hash);
    out.push({
      kind: 'system_prompt',
      text: text.slice(0, limits.textChars),
      hash,
      capturedAt: new Date(entry.mtimeMs).toISOString(),
    });
  }
  log(`system prompts: scanned=${scanned} matched=${out.length} session=${sessionId}`);
  return out;
}

/** transcript 里工具输出的形状很杂(字符串 / 内容块数组 / {stdout,stderr} / {content:[…]}),拍平成文本。 */
function flattenToolOutput(value, depth = 0) {
  if (value == null || depth > 4) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((block) => (typeof block === 'string' ? block : block && typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value === 'object') {
    for (const key of ['content', 'output', 'result', 'stdout', 'text']) {
      if (value[key] === undefined) continue;
      const text = flattenToolOutput(value[key], depth + 1);
      if (text.trim()) return text;
    }
    if (typeof value.stderr === 'string' && value.stderr.trim()) return value.stderr;
    try {
      return JSON.stringify(value);  // 结构化但认不出正文字段:整体带走总好过丢
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * 单趟流式扫 transcript,同时收 hook 注入上下文与工具输出。
 * 只扫一遍是刻意的:大会话动辄几十万行、上百 MB,读两遍不值当。
 */
function scanTranscript(transcriptPath, limits) {
  return new Promise((resolve) => {
    const hookContexts = [];
    const outputs = new Map();      // tool_use_id → { text, isError, capturedAt }
    const agentToolIds = new Set(); // Task/Agent 调用的 tool_use_id,选取时优先保留
    const done = () => resolve({ hookContexts, outputs, agentToolIds });

    if (!transcriptPath || !fs.existsSync(transcriptPath)) return done();

    let bytes = 0;
    let stream;
    try {
      stream = fs.createReadStream(transcriptPath, { encoding: 'utf8' });
    } catch {
      return done();
    }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const finish = () => { try { rl.close(); stream.destroy(); } catch {} done(); };

    rl.on('line', (line) => {
      bytes += line.length;
      if (bytes > limits.transcriptBytes) return finish();
      // 子串预筛,避免对每一行都 JSON.parse
      const hasHook = line.indexOf('"hook_additional_context"') !== -1;
      const hasToolResult = line.indexOf('"tool_result"') !== -1 || line.indexOf('"toolUseResult"') !== -1;
      const hasToolUse = line.indexOf('"tool_use"') !== -1;
      if (!hasHook && !hasToolResult && !hasToolUse) return;

      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return;
      }

      // ① hook 注入的 additionalContext
      const attachment = entry.attachment;
      if (attachment && attachment.type === 'hook_additional_context' && hookContexts.length < limits.hookItems) {
        const parts = Array.isArray(attachment.content) ? attachment.content : [attachment.content];
        const text = parts.filter((part) => typeof part === 'string' && part.trim()).join('\n').trim();
        if (text) {
          hookContexts.push({
            kind: 'hook_context',
            text: text.slice(0, limits.textChars),
            hash: sha256(`${attachment.hookEvent || ''}:${text}`),
            hookEvent: attachment.hookEvent || attachment.hookName || undefined,
            hookName: attachment.hookName || undefined,
            capturedAt: entry.timestamp,
          });
        }
      }

      const content = entry.message && Array.isArray(entry.message.content) ? entry.message.content : [];

      // ② 助手轮里的 tool_use:记住哪些是子 agent 调用(它们的输出优先保留)
      for (const block of content) {
        if (!block || block.type !== 'tool_use' || !block.id) continue;
        if (block.name === 'Agent' || block.name === 'Task') agentToolIds.add(block.id);
      }

      // ③ 工具输出:用户轮里的 tool_result 块是主源,entry.toolUseResult 是兜底
      for (const block of content) {
        if (!block || block.type !== 'tool_result') continue;
        const toolUseId = block.tool_use_id || block.toolUseId || block.id;
        if (!toolUseId) continue;
        const text = flattenToolOutput(block.content !== undefined ? block.content : block.output);
        if (!text.trim()) continue;
        outputs.set(String(toolUseId), {
          text: text.slice(0, limits.toolOutputChars),
          isError: block.is_error === true,
          capturedAt: entry.timestamp,
        });
      }
      if (entry.toolUseResult !== undefined && entry.toolUseID) {
        const id = String(entry.toolUseID);
        if (!outputs.has(id)) {
          const text = flattenToolOutput(entry.toolUseResult);
          if (text.trim()) {
            outputs.set(id, { text: text.slice(0, limits.toolOutputChars), isError: false, capturedAt: entry.timestamp });
          }
        }
      }
    });
    rl.on('close', done);
    rl.on('error', done);
    stream.on('error', done);
  });
}

/** 只要 hook 上下文时的薄封装(单测和排障用)。 */
async function collectHookContexts(transcriptPath, limits) {
  return (await scanTranscript(transcriptPath, limits)).hookContexts;
}

/**
 * 工具输出转成补传项。超过上限时**优先保留子 agent(Task)调用的输出** ——
 * 少一条普通工具输出只是缺个细节,少一条 Task 输出会让整棵子 agent 子树建不出来。
 */
function toolOutputItems(scan, limits) {
  const entries = [...scan.outputs.entries()];
  const agentToolIds = scan.agentToolIds;
  const ordered = [
    ...entries.filter(([id]) => agentToolIds.has(id)),
    ...entries.filter(([id]) => !agentToolIds.has(id)),
  ].slice(0, limits.toolOutputs);

  return ordered.map(([toolUseId, value]) => ({
    kind: 'tool_output',
    toolUseId,
    text: value.text,
    isError: value.isError,
    hash: sha256(`${toolUseId}:${value.text}`),
    capturedAt: value.capturedAt,
  }));
}

/** 只要工具输出时的薄封装(单测和排障用)。 */
async function collectToolOutputs(transcriptPath, limits) {
  return toolOutputItems(await scanTranscript(transcriptPath, limits), limits);
}

/**
 * 子 agent 归属映射。子 agent 的轮次**不在主 transcript 里**,单独存在
 * `<transcript 同目录>/<sessionId>/subagents/agent-<id>.jsonl`,配套的
 * `agent-<id>.meta.json` 里 `toolUseId` 直连父侧那条 Task/Agent tool_use。
 *
 * OTel 事件里没有任何 agent 标识(实测 attributes 只有 session.id / prompt.id 等),
 * 但 assistant_response 带 message.uuid、tool_result 带 tool_use_id ——
 * 与子 agent jsonl 里的 uuid / tool_use.id 恰好一一对应(且与主 transcript 不相交)。
 * 把这两组 id 连同 meta.toolUseId 传上去,服务端就能把平铺在 root 的子 agent
 * 内部轮次逐轮归还给对应的子 agent 节点。
 */
function collectSubagentMaps(transcriptPath, sessionId, limits) {
  const items = [];
  const outputs = new Map();      // 子 agent 内部工具的输出:tool_use_id → { text, isError, capturedAt }
  const agentToolIds = new Set(); // 内部再 spawn(depth 2)的 Task 调用,输出优先保留
  const result = { items, outputs, agentToolIds };
  if (!transcriptPath || !sessionId) return result;
  const dir = path.join(path.dirname(transcriptPath), sessionId, 'subagents');
  let metaNames;
  try {
    metaNames = fs.readdirSync(dir).filter((name) => /^agent-.*\.meta\.json$/.test(name)).sort();
  } catch {
    return result; // 没有 subagents 目录 = 本会话没 spawn 过子 agent
  }

  for (const metaName of metaNames.slice(0, limits.subagentMaps)) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, metaName), 'utf8'));
      const toolUseId = typeof meta.toolUseId === 'string' ? meta.toolUseId.trim() : '';
      if (!toolUseId) continue; // 挂不回任何一次 Task 调用,传了也没用

      const jsonlPath = path.join(dir, metaName.replace(/\.meta\.json$/, '.jsonl'));
      const stat = fs.statSync(jsonlPath);
      if (stat.size > limits.subagentFileBytes) continue;

      const messageUuids = [];
      const toolUseIds = [];
      for (const line of fs.readFileSync(jsonlPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const content = entry.message && Array.isArray(entry.message.content) ? entry.message.content : [];
        if (entry.type === 'assistant') {
          if (typeof entry.uuid === 'string' && messageUuids.length < limits.subagentMapIds) {
            messageUuids.push(entry.uuid);
          }
          for (const block of content) {
            if (!block || block.type !== 'tool_use' || typeof block.id !== 'string') continue;
            if (toolUseIds.length < limits.subagentMapIds) toolUseIds.push(block.id);
            if (block.name === 'Agent' || block.name === 'Task') agentToolIds.add(block.id);
          }
          continue;
        }
        // 内部工具输出只存在于这份 jsonl(主 transcript 里没有),与 scanTranscript 同口径拍平
        for (const block of content) {
          if (!block || block.type !== 'tool_result') continue;
          const id = block.tool_use_id || block.toolUseId || block.id;
          if (!id) continue;
          const text = flattenToolOutput(block.content !== undefined ? block.content : block.output);
          if (!text.trim()) continue;
          outputs.set(String(id), {
            text: text.slice(0, limits.toolOutputChars),
            isError: block.is_error === true,
            capturedAt: entry.timestamp,
          });
        }
        if (entry.toolUseResult !== undefined && entry.toolUseID && !outputs.has(String(entry.toolUseID))) {
          const text = flattenToolOutput(entry.toolUseResult);
          if (text.trim()) {
            outputs.set(String(entry.toolUseID), { text: text.slice(0, limits.toolOutputChars), isError: false, capturedAt: entry.timestamp });
          }
        }
      }
      if (messageUuids.length === 0 && toolUseIds.length === 0) continue;

      const payload = {
        toolUseId,
        agentType: typeof meta.agentType === 'string' ? meta.agentType : undefined,
        spawnDepth: Number.isFinite(meta.spawnDepth) ? meta.spawnDepth : undefined,
        messageUuids,
        toolUseIds,
      };
      const text = JSON.stringify(payload);
      items.push({
        kind: 'subagent_map',
        toolUseId,
        text,
        hash: sha256(`subagent_map:${text}`), // 会话继续跑、映射长大 → 新 hash → 重传全量映射,服务端取并集
        capturedAt: new Date(stat.mtimeMs).toISOString(),
      });
    } catch {}
  }
  log(`subagent maps: ${items.length}, inner tool outputs: ${outputs.size} from ${dir}`);
  return result;
}

function checkpointPath(apiKey) {
  const suffix = apiKey ? sha256(apiKey).slice(0, 16) : 'anonymous';
  return path.join(BASE_DIR, `claude_context_checkpoint_${suffix}.json`);
}

function loadCheckpoint(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.sessions) return parsed;
  } catch {}
  return { version: 1, sessions: {} };
}

function saveCheckpoint(file, checkpoint, limits) {
  try {
    const ids = Object.keys(checkpoint.sessions);
    if (ids.length > limits.checkpointSessions) {
      ids
        .sort((a, b) => (checkpoint.sessions[a].updatedAt || '').localeCompare(checkpoint.sessions[b].updatedAt || ''))
        .slice(0, ids.length - limits.checkpointSessions)
        .forEach((id) => delete checkpoint.sessions[id]);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(checkpoint), 'utf8');
  } catch {}
}

function postJson(url, apiKey, payload, timeoutMs) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      return resolve({ ok: false, status: 0, error: 'bad url' });
    }
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const client = target.protocol === 'https:' ? https : http;
    const req = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          'x-witty-api-key': apiKey || '',
        },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timeout' }); });
    req.on('error', (err) => resolve({ ok: false, status: 0, error: err.message }));
    req.write(body);
    req.end();
  });
}

// ─── hook 注册(幂等,不覆盖用户已有配置)────────────────────────────────────────
function hookCommand() {
  const node = process.execPath && path.basename(process.execPath).startsWith('node') ? process.execPath : 'node';
  // 注册**当前运行的这份**的路径。安装名是 .cjs:~/.agent-insight/ 里有 package.json
  // 且 "type":"module"(装机脚本历史产物),.js 会被 node 当 ESM 跑,require 直接崩。
  return `${JSON.stringify(node)} ${JSON.stringify(__filename)}`;
}

function isOurHook(entry) {
  // 不带扩展名匹配:老版本注册的是 .js,升级到 .cjs 后要能认出并替换/摘除它
  return !!entry && typeof entry.command === 'string' && entry.command.includes('claude_context_uploader');
}

function mutateSettings(mutate) {
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')) || {};
  } catch {}
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  const changed = mutate(settings);
  if (!changed) return false;
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return true;
}

function installHook() {
  const command = hookCommand();
  const changed = mutateSettings((settings) => {
    const list = Array.isArray(settings.hooks.SessionEnd) ? settings.hooks.SessionEnd : [];
    for (const matcher of list) {
      const hooks = Array.isArray(matcher && matcher.hooks) ? matcher.hooks : [];
      const mine = hooks.find(isOurHook);
      if (mine) {
        if (mine.command === command) return false;  // 已是最新,零改动
        mine.command = command;                      // 只更新自己那条(比如 node 路径变了)
        return true;
      }
    }
    list.push({ hooks: [{ type: 'command', command, timeout: 30 }] });
    settings.hooks.SessionEnd = list;
    return true;
  });
  console.log(changed
    ? `✅ Claude Code SessionEnd hook 已注册到 ${CLAUDE_SETTINGS}`
    : `✅ Claude Code SessionEnd hook 已是最新(${CLAUDE_SETTINGS})`);
}

function uninstallHook() {
  const changed = mutateSettings((settings) => {
    const list = Array.isArray(settings.hooks.SessionEnd) ? settings.hooks.SessionEnd : [];
    let touched = false;
    const kept = [];
    for (const matcher of list) {
      const hooks = Array.isArray(matcher && matcher.hooks) ? matcher.hooks : [];
      const remaining = hooks.filter((hook) => !isOurHook(hook));
      if (remaining.length !== hooks.length) touched = true;
      if (remaining.length > 0) kept.push({ ...matcher, hooks: remaining });
      else if (remaining.length === 0 && hooks.length === 0) kept.push(matcher);
    }
    if (!touched) return false;
    if (kept.length > 0) settings.hooks.SessionEnd = kept;
    else delete settings.hooks.SessionEnd;
    return true;
  });
  console.log(changed ? '✅ 已从 settings.json 摘除本 hook' : 'ℹ️  settings.json 里没有本 hook');
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────
async function main() {
  const arg = process.argv[2];
  if (arg === '--install-hook') return installHook();
  if (arg === '--uninstall-hook') return uninstallHook();
  const dryRun = arg === '--dry-run';

  const env = readEnvFile();
  if (isOff(conf(env, 'AGENT_INSIGHT_CLAUDE_CONTEXT_ENABLE', 'true'))) return log('disabled by config');

  const raw = await readStdin();
  let payload = {};
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    return log('stdin is not JSON, skip');
  }
  const sessionId = String(payload.session_id || '').trim();
  if (!sessionId) return log('no session_id in hook payload, skip');

  const limits = {
    ...LIMITS,
    textChars: numberConf(env, 'AGENT_INSIGHT_CLAUDE_CONTEXT_MAX_TEXT', LIMITS.textChars),
    hookItems: numberConf(env, 'AGENT_INSIGHT_CLAUDE_CONTEXT_MAX_ITEMS', LIMITS.hookItems),
    rawBodyFiles: numberConf(env, 'AGENT_INSIGHT_CLAUDE_CONTEXT_MAX_BODY_FILES', LIMITS.rawBodyFiles),
    toolOutputs: numberConf(env, 'AGENT_INSIGHT_CLAUDE_CONTEXT_MAX_TOOL_OUTPUTS', LIMITS.toolOutputs),
    // 与平台既有的工具输入输出上限同口径,客户没配就用 4000
    toolOutputChars: numberConf(env, 'AGENT_INSIGHT_MAX_TOOL_IO', LIMITS.toolOutputChars),
  };

  const rawBodyDir = String(conf(env, 'AGENT_INSIGHT_CLAUDE_OTEL_RAW_API_BODIES', `file:${path.join(BASE_DIR, 'claude_raw_bodies')}`))
    .replace(/^file:/, '');

  const wantHooks = !isOff(conf(env, 'AGENT_INSIGHT_CLAUDE_CONTEXT_HOOKS', 'true'));
  const wantTools = !isOff(conf(env, 'AGENT_INSIGHT_CLAUDE_CONTEXT_TOOLS', 'true'));

  const items = [];
  if (!isOff(conf(env, 'AGENT_INSIGHT_CLAUDE_CONTEXT_SYSTEM', 'true'))) {
    items.push(...collectSystemPrompts(rawBodyDir, sessionId, limits));
  }
  if (wantHooks || wantTools) {
    const scan = await scanTranscript(payload.transcript_path, limits);  // 只扫一遍 transcript
    if (wantHooks) items.push(...scan.hookContexts);
    if (wantTools) {
      // 子 agent 归属映射跟工具输出同一开关:两者都是为了把子 agent 子树建出来。
      // 内部工具输出并进同一个 outputs 池,让全局上限与"优先保 Task 输出"一并生效。
      const sub = collectSubagentMaps(payload.transcript_path, sessionId, limits);
      for (const [id, value] of sub.outputs) {
        if (!scan.outputs.has(id)) scan.outputs.set(id, value);
      }
      for (const id of sub.agentToolIds) scan.agentToolIds.add(id);
      items.push(...toolOutputItems(scan, limits));
      items.push(...sub.items);
    }
  }
  if (dryRun) {
    // 只报"会传什么",绝不外发,也不动 checkpoint —— 支持同学排障用得上。
    console.log(JSON.stringify({
      sessionId,
      host: normalizeHost(conf(env, 'AGENT_INSIGHT_HOST', 'http://127.0.0.1:3000')),
      rawBodyDir,
      transcript: payload.transcript_path,
      items: items.map((item) => ({
        kind: item.kind,
        chars: item.text.length,
        hash: item.hash.slice(0, 12),
        hookEvent: item.hookEvent,
        hookName: item.hookName,
        toolUseId: item.toolUseId,
        preview: item.text.slice(0, 80).replace(/\s+/g, ' '),
      })),
    }, null, 2));
    return;
  }

  if (items.length === 0) return log(`nothing to supplement for ${sessionId}`);

  const apiKey = String(conf(env, 'AGENT_INSIGHT_API_KEY', ''));
  const file = checkpointPath(apiKey);
  const checkpoint = loadCheckpoint(file);
  const known = new Set((checkpoint.sessions[sessionId] || {}).hashes || []);
  const fresh = items.filter((item) => !known.has(item.hash));
  if (fresh.length === 0) return log(`all ${items.length} items already uploaded for ${sessionId}`);

  const host = normalizeHost(conf(env, 'AGENT_INSIGHT_HOST', 'http://127.0.0.1:3000'));
  const url = `${host}/api/ingest/claude/context`;

  // 分批发:服务端单次有条数上限,一股脑发会被静默截断丢数据。只把发成功的批次记进 checkpoint。
  const uploaded = [];
  for (let i = 0; i < fresh.length; i += limits.uploadBatchSize) {
    const batch = fresh.slice(i, i + limits.uploadBatchSize);
    let result = await postJson(url, apiKey, { sessionId, items: batch }, limits.requestTimeoutMs);
    if (!result.ok) result = await postJson(url, apiKey, { sessionId, items: batch }, limits.requestTimeoutMs);
    log(`upload ${batch.length} items -> ${url} ok=${result.ok} status=${result.status} ${result.error || ''}`);
    if (!result.ok) break;  // 失败就停,剩下的留给下次(hash 没进 checkpoint,不会漏)
    uploaded.push(...batch);
  }
  if (uploaded.length === 0) return;

  checkpoint.sessions[sessionId] = {
    hashes: [...known, ...uploaded.map((item) => item.hash)].slice(-500),
    updatedAt: new Date().toISOString(),
  };
  saveCheckpoint(file, checkpoint, limits);
}

// 被 require 时只导出纯函数(供单测直接验抽取逻辑);只有直接执行才跑主流程。
module.exports = {
  LIMITS,
  collectSystemPrompts,
  collectHookContexts,
  collectToolOutputs,
  collectSubagentMaps,
  scanTranscript,
  toolOutputItems,
  flattenSystem,
  flattenToolOutput,
  sessionIdOfBody,
  normalizeHost,
};

if (require.main === module) {
  main().catch((err) => log(`fatal: ${err && err.message}`)).finally(() => process.exit(0));
}
