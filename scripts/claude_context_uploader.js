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
 * 三者都只存在于【客户端本机磁盘】,所以由本脚本在每轮结束后捞出来发给平台。
 *
 * 用法:
 *   node claude_context_uploader.js              # SessionEnd 入队并排空兜底(从 stdin 读 hook 负载)
 *   node claude_context_uploader.js --enqueue    # Stop/SubagentStop/StopFailure 快速入队
 *   node claude_context_uploader.js --drain-queue # 后台排空队列
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
const childProcess = require('child_process');

const HOME = os.homedir();
const BASE_DIR = path.join(HOME, '.agent-insight');
const ENV_FILE = path.join(BASE_DIR, '.env');
const CLAUDE_SETTINGS = path.join(HOME, '.claude', 'settings.json');
const QUEUE_DIR = path.join(BASE_DIR, 'claude_context_queue');
const WORKER_START_TOKEN = '.worker-starting';
const WORKER_START_TOKEN_STALE_MS = 30 * 1000;
const REALTIME_HOOK_EVENTS = ['Stop', 'SubagentStop', 'StopFailure'];
const ALL_HOOK_EVENTS = [...REALTIME_HOOK_EVENTS, 'SessionEnd'];

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
  subagentScopeMtimeMs: 30 * 1000,
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

function flattenRequestMessages(messages) {
  if (!Array.isArray(messages)) return '';
  return messages
    .map((message) => flattenToolOutput(message && message.content))
    .filter(Boolean)
    .join('\n');
}

function isInternalTitleSystem(text) {
  return /^Generate a concise, sentence-case title\b/i.test(String(text || '').trim());
}

function collectSystemPrompts(rawBodyDir, sessionId, limits, context = {}) {
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

  const agentCalls = context.agentCalls instanceof Map ? context.agentCalls : new Map();
  const scopeByToolId = new Map();
  for (const scope of Array.isArray(context.subagentScopes) ? context.subagentScopes : []) {
    if (!scope || !scope.toolUseId) continue;
    scopeByToolId.set(String(scope.toolUseId), { ...scope, toolUseId: String(scope.toolUseId) });
  }
  for (const [toolUseId, call] of agentCalls) {
    const current = scopeByToolId.get(String(toolUseId)) || { toolUseId: String(toolUseId) };
    scopeByToolId.set(String(toolUseId), {
      ...current,
      prompt: typeof call?.prompt === 'string' ? call.prompt.trim() : current.prompt,
      agentType: typeof call?.agentType === 'string' ? call.agentType : current.agentType,
    });
  }
  const usedScopes = new Set();
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
    if (!text || isInternalTitleSystem(text)) continue;

    let scope;
    if (text.includes('cc_is_subagent=true')) {
      const requestText = flattenRequestMessages(body.messages);
      const available = [...scopeByToolId.values()].filter((candidate) => !usedScopes.has(candidate.toolUseId));
      const exact = available
        .filter((candidate) => candidate.prompt && requestText.includes(candidate.prompt))
        .sort((a, b) => b.prompt.length - a.prompt.length);
      scope = exact[0];
      if (!scope) {
        const maxDelta = Number(limits.subagentScopeMtimeMs) || LIMITS.subagentScopeMtimeMs;
        scope = available
          .filter((candidate) => Number.isFinite(candidate.mtimeMs))
          .map((candidate) => ({ candidate, delta: Math.abs(entry.mtimeMs - candidate.mtimeMs) }))
          .filter(({ delta }) => delta <= maxDelta)
          .sort((a, b) => a.delta - b.delta)[0]?.candidate;
      }
      if (!scope) continue;
      usedScopes.add(scope.toolUseId);
    }

    const hash = sha256(text);
    const dedupeKey = `${scope?.toolUseId || 'root'}:${hash}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const item = {
      kind: 'system_prompt',
      text: text.slice(0, limits.textChars),
      hash,
      capturedAt: new Date(entry.mtimeMs).toISOString(),
    };
    if (scope) {
      item.toolUseId = scope.toolUseId;
      if (scope.agentType) item.agentType = scope.agentType;
      item.hash = sha256(`${scope.toolUseId}:${text}`);
    }
    out.push(item);
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
 * startOffset 必须是上一次成功处理到的字节位置;读取上限落在半行时不推进那一行,
 * 下一轮会从完整 JSONL 行头重读,不会因 UTF-8 字符宽度或分块边界丢数据。
 */
function scanTranscript(transcriptPath, limits, options = {}) {
  return new Promise((resolve) => {
    const hookContexts = [];
    const outputs = new Map();      // tool_use_id → { text, isError, capturedAt }
    const agentToolIds = new Set(); // Task/Agent 调用的 tool_use_id,选取时优先保留
    const agentCalls = new Map();   // tool_use_id → { prompt, agentType },给 child system prompt 定位
    let settled = false;
    let processedOffset = 0;
    const done = (nextOffset = processedOffset) => {
      if (settled) return;
      settled = true;
      resolve({ hookContexts, outputs, agentToolIds, agentCalls, nextOffset });
    };

    if (!transcriptPath) return done(0);
    let stat;
    try {
      stat = fs.statSync(transcriptPath);
    } catch {
      return done(0);
    }

    let startOffset = Math.max(0, Math.floor(Number(options.startOffset) || 0));
    if (startOffset > stat.size) startOffset = 0; // transcript 被轮转/截短
    processedOffset = startOffset;
    if (startOffset === stat.size) return done(stat.size);

    const maxBytes = Math.max(1, Math.floor(Number(limits.transcriptBytes) || LIMITS.transcriptBytes));
    const endExclusive = Math.min(stat.size, startOffset + maxBytes);
    let pending = Buffer.alloc(0);
    let stream;

    const processLine = (lineBuffer) => {
      if (lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === 13) {
        lineBuffer = lineBuffer.subarray(0, lineBuffer.length - 1);
      }
      const line = lineBuffer.toString('utf8');
      // 子串预筛,避免对每一行都 JSON.parse
      const hasHook = line.indexOf('"hook_additional_context"') !== -1;
      const hasToolResult = line.indexOf('"tool_result"') !== -1 || line.indexOf('"toolUseResult"') !== -1;
      const hasToolUse = line.indexOf('"tool_use"') !== -1;
      if (!hasHook && !hasToolResult && !hasToolUse) return true;

      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return false;
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
        if (block.name === 'Agent' || block.name === 'Task') {
          agentToolIds.add(block.id);
          agentCalls.set(String(block.id), {
            prompt: typeof block.input?.prompt === 'string' ? block.input.prompt.trim() : '',
            agentType: typeof block.input?.subagent_type === 'string' ? block.input.subagent_type : undefined,
          });
        }
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
      return true;
    };

    try {
      stream = fs.createReadStream(transcriptPath, { start: startOffset, end: endExclusive - 1 });
    } catch {
      return done(startOffset);
    }
    stream.on('data', (chunk) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let newline;
      while ((newline = pending.indexOf(10)) !== -1) {
        const line = pending.subarray(0, newline);
        processLine(line); // 有换行的损坏记录可安全跳过,否则会永久卡住 checkpoint
        pending = pending.subarray(newline + 1);
        processedOffset += newline + 1;
      }
    });
    stream.on('end', () => {
      if (endExclusive === stat.size && pending.length > 0) {
        // 没有换行的最后一条可能正被 Claude Code 写入;只有完整 JSON 才推进 checkpoint。
        try {
          JSON.parse(pending.toString('utf8'));
          processLine(pending);
          processedOffset += pending.length;
        } catch {}
      }
      done(processedOffset);
    });
    stream.on('error', () => done(processedOffset));
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
  const scopes = [];              // 父 tool_use_id → agentType / meta mtime,给 raw body 有界兜底
  const result = { items, outputs, agentToolIds, scopes };
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
      const metaPath = path.join(dir, metaName);
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const toolUseId = typeof meta.toolUseId === 'string' ? meta.toolUseId.trim() : '';
      if (!toolUseId) continue; // 挂不回任何一次 Task 调用,传了也没用
      const metaStat = fs.statSync(metaPath);
      scopes.push({
        toolUseId,
        agentType: typeof meta.agentType === 'string' ? meta.agentType : undefined,
        mtimeMs: metaStat.mtimeMs,
      });

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
    atomicWriteJson(file, checkpoint);
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

function mutateSettings(mutate, settingsPath = CLAUDE_SETTINGS) {
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) || {};
  } catch {}
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  const changed = mutate(settings);
  if (!changed) return false;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return true;
}

function upsertHook(settings, event, command, timeout) {
  const list = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  let found = false;
  let changed = false;
  const kept = [];
  for (const matcher of list) {
    const hooks = Array.isArray(matcher && matcher.hooks) ? matcher.hooks : [];
    const nextHooks = [];
    for (const hook of hooks) {
      if (!isOurHook(hook)) {
        nextHooks.push(hook);
        continue;
      }
      if (found) {
        changed = true; // 清理重复的旧安装项
        continue;
      }
      found = true;
      const next = { ...hook, type: 'command', command, timeout };
      if (JSON.stringify(next) !== JSON.stringify(hook)) changed = true;
      nextHooks.push(next);
    }
    if (nextHooks.length > 0 || hooks.length === 0) kept.push({ ...matcher, hooks: nextHooks });
    else changed = true;
  }
  if (!found) {
    kept.push({ hooks: [{ type: 'command', command, timeout }] });
    changed = true;
  }
  settings.hooks[event] = kept;
  return changed;
}

function installHook(options = {}) {
  const command = options.command || hookCommand();
  const settingsPath = options.settingsPath || CLAUDE_SETTINGS;
  const changed = mutateSettings((settings) => {
    let touched = false;
    for (const event of REALTIME_HOOK_EVENTS) {
      if (upsertHook(settings, event, `${command} --enqueue`, 5)) touched = true;
    }
    if (upsertHook(settings, 'SessionEnd', command, 30)) touched = true;
    return touched;
  }, settingsPath);
  if (!options.quiet) {
    console.log(changed
      ? `✅ Claude Code 每轮异步补传 hook 与 SessionEnd 兜底已注册到 ${settingsPath}`
      : `✅ Claude Code 上下文补传 hook 已是最新(${settingsPath})`);
  }
  return changed;
}

function uninstallHook(options = {}) {
  const settingsPath = options.settingsPath || CLAUDE_SETTINGS;
  const changed = mutateSettings((settings) => {
    let touched = false;
    for (const event of ALL_HOOK_EVENTS) {
      const list = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
      const kept = [];
      for (const matcher of list) {
        const hooks = Array.isArray(matcher && matcher.hooks) ? matcher.hooks : [];
        const remaining = hooks.filter((hook) => !isOurHook(hook));
        if (remaining.length !== hooks.length) touched = true;
        if (remaining.length > 0) kept.push({ ...matcher, hooks: remaining });
        else if (hooks.length === 0) kept.push(matcher);
      }
      if (kept.length > 0) settings.hooks[event] = kept;
      else if (list.length > 0) delete settings.hooks[event];
    }
    return touched;
  }, settingsPath);
  if (!options.quiet) {
    console.log(changed ? '✅ 已从 settings.json 摘除本 hook' : 'ℹ️  settings.json 里没有本 hook');
  }
  return changed;
}

// ─── 每轮补传队列(实时 hook 只落盘,网络由 detached worker 处理)────────────────
function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    } catch {}
  }
}

function queueFile(queueDir, sessionId) {
  return path.join(queueDir, `job-${sha256(sessionId).slice(0, 32)}.json`);
}

function spawnDetachedWorker() {
  try {
    const child = childProcess.spawn(process.execPath || 'node', [__filename, '--drain-queue'], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    return true;
  } catch (error) {
    log(`spawn queue worker failed: ${error && error.message}`);
    return false;
  }
}

function workerStartTokenPath(queueDir) {
  return path.join(queueDir, WORKER_START_TOKEN);
}

function releaseWorkerStartToken(queueDir) {
  try {
    fs.unlinkSync(workerStartTokenPath(queueDir));
  } catch {}
}

function claimWorkerStartToken(queueDir, staleMs = WORKER_START_TOKEN_STALE_MS) {
  fs.mkdirSync(queueDir, { recursive: true });
  const token = workerStartTokenPath(queueDir);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = fs.openSync(token, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), 'utf8');
      fs.closeSync(fd);
      return true;
    } catch (error) {
      try {
        if (fd !== undefined) fs.closeSync(fd);
      } catch {}
      if (!error || error.code !== 'EEXIST') return false;
      let ageMs = Infinity;
      try {
        ageMs = Date.now() - fs.statSync(token).mtimeMs;
      } catch {}
      if (ageMs < staleMs) return false;

      // drain worker 仍活着时不抢令牌;长上传只需要一个 worker。
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(queueDir, '.drain.lock'), 'utf8'));
        if (isProcessAlive(Number(owner.pid))) return false;
      } catch {}
      try {
        fs.unlinkSync(token);
      } catch {
        return false;
      }
    }
  }
  return false;
}

function scheduleWorker(queueDir, spawnWorker) {
  if (!claimWorkerStartToken(queueDir)) return false;
  try {
    const started = spawnWorker();
    if (started === false) {
      releaseWorkerStartToken(queueDir);
      return false;
    }
    return true;
  } catch (error) {
    releaseWorkerStartToken(queueDir);
    throw error;
  }
}

function enqueuePayload(payload, options = {}) {
  const sessionId = String(payload && payload.session_id || '').trim();
  if (!sessionId) return false;
  const queueDir = options.queueDir || QUEUE_DIR;
  const normalized = {
    session_id: sessionId,
    transcript_path: String(payload.transcript_path || '').trim(),
    hook_event_name: String(payload.hook_event_name || '').trim() || undefined,
    agent_id: String(payload.agent_id || '').trim() || undefined,
    agent_type: String(payload.agent_type || '').trim() || undefined,
    queued_at: new Date().toISOString(),
  };
  try {
    atomicWriteJson(queueFile(queueDir, sessionId), normalized);
  } catch (error) {
    log(`enqueue failed for ${sessionId}: ${error && error.message}`);
    return false;
  }
  const spawnWorker = options.spawnWorker || spawnDetachedWorker;
  try {
    scheduleWorker(queueDir, spawnWorker);
  } catch (error) {
    log(`start worker failed for ${sessionId}: ${error && error.message}`);
  }
  return true;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!error && error.code === 'EPERM';
  }
}

function acquireQueueLock(lockFile) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), 'utf8');
      fs.closeSync(fd);
      return true;
    } catch (error) {
      try {
        if (fd !== undefined) fs.closeSync(fd);
      } catch {}
      if (!error || error.code !== 'EEXIST') return false;
      let owner = {};
      let ageMs = Infinity;
      try {
        owner = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        ageMs = Date.now() - fs.statSync(lockFile).mtimeMs;
      } catch {}
      if (isProcessAlive(Number(owner.pid))) return false;
      // 刚创建但尚未写完的空锁可能属于活 worker,留一个短暂保护窗。
      if (!owner.pid && ageMs < 30000) return false;
      try {
        fs.unlinkSync(lockFile);
      } catch {
        return false;
      }
    }
  }
  return false;
}

function listQueueJobs(queueDir) {
  try {
    return fs.readdirSync(queueDir)
      .filter((name) => /^job-[a-f0-9]+\.json$/.test(name))
      .map((name) => path.join(queueDir, name))
      .sort();
  } catch {
    return [];
  }
}

function recoverClaimedJobs(queueDir) {
  let names;
  try {
    names = fs.readdirSync(queueDir);
  } catch {
    return;
  }
  for (const name of names) {
    const match = /^(job-[a-f0-9]+\.json)\.processing-/.exec(name);
    if (!match) continue;
    const claimed = path.join(queueDir, name);
    const original = path.join(queueDir, match[1]);
    try {
      if (fs.existsSync(original)) fs.unlinkSync(claimed); // 新任务已覆盖它
      else fs.renameSync(claimed, original);
    } catch {}
  }
}

async function drainQueue(options = {}) {
  const queueDir = options.queueDir || QUEUE_DIR;
  const lockFile = options.lockFile || path.join(queueDir, '.drain.lock');
  const processPayload = options.processPayload || uploadPayload;
  const spawnWorker = options.spawnWorker || spawnDetachedWorker;
  const summary = { processed: 0, failed: 0, locked: false };
  if (!acquireQueueLock(lockFile)) {
    summary.locked = true;
    return summary;
  }
  // 直接 SessionEnd drain 或测试调用可能没有前置 enqueue 持令牌;持锁期间也补上，
  // 避免并发 Stop 每条都拉起一个注定抢不到 .drain.lock 的进程。
  claimWorkerStartToken(queueDir);

  const attempted = new Set();
  const deferredFailures = new Map();
  try {
    recoverClaimedJobs(queueDir);
    while (true) {
      const next = listQueueJobs(queueDir).find((file) => !attempted.has(file));
      if (!next) break;
      attempted.add(next);
      const claimed = `${next}.processing-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      try {
        fs.renameSync(next, claimed);
      } catch {
        continue;
      }

      let payload;
      let ok = false;
      try {
        payload = JSON.parse(fs.readFileSync(claimed, 'utf8'));
        ok = await processPayload(payload);
      } catch (error) {
        log(`queue job failed: ${error && error.message}`);
      }

      if (ok) {
        summary.processed += 1;
        try {
          fs.unlinkSync(claimed);
        } catch {}
        continue;
      }

      summary.failed += 1;
      try {
        if (fs.existsSync(next)) fs.unlinkSync(claimed); // 新任务更新,它已覆盖旧任务
        else {
          fs.renameSync(claimed, next);
          deferredFailures.set(next, String(payload && payload.queued_at || ''));
        }
      } catch {}
    }
  } finally {
    try {
      fs.unlinkSync(lockFile);
    } catch {}
    releaseWorkerStartToken(queueDir);
    // 只为并发新任务补 worker;本轮失败后原样放回的任务留给下一次 hook,避免离线时自旋。
    const shouldContinue = listQueueJobs(queueDir).some((file) => {
      if (!deferredFailures.has(file)) return true;
      try {
        const current = JSON.parse(fs.readFileSync(file, 'utf8'));
        return String(current.queued_at || '') !== deferredFailures.get(file);
      } catch {
        return false;
      }
    });
    if (shouldContinue) {
      try {
        scheduleWorker(queueDir, spawnWorker);
      } catch {}
    }
  }
  return summary;
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────
async function uploadPayload(payload, options = {}) {
  const dryRun = options.dryRun === true;
  const env = readEnvFile();
  if (isOff(conf(env, 'AGENT_INSIGHT_CLAUDE_CONTEXT_ENABLE', 'true'))) {
    log('disabled by config');
    return true;
  }
  const sessionId = String(payload.session_id || '').trim();
  if (!sessionId) {
    log('no session_id in hook payload, skip');
    return true;
  }

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
  const wantSystem = !isOff(conf(env, 'AGENT_INSIGHT_CLAUDE_CONTEXT_SYSTEM', 'true'));
  const apiKey = String(conf(env, 'AGENT_INSIGHT_API_KEY', ''));
  const file = checkpointPath(apiKey);
  const checkpoint = loadCheckpoint(file);
  const previous = checkpoint.sessions[sessionId] || {};
  const transcriptPath = String(payload.transcript_path || '').trim();
  const canResume = !dryRun
    && previous.transcriptPath === transcriptPath
    && Number.isFinite(previous.transcriptOffset);
  const startOffset = canResume ? previous.transcriptOffset : 0;

  const items = [];
  let scan;
  let sub;
  if (wantHooks || wantTools || wantSystem) {
    scan = await scanTranscript(transcriptPath, limits, { startOffset }); // 只扫新增 transcript
    for (const id of previous.agentToolIds || []) scan.agentToolIds.add(id);
    if (wantTools || wantSystem) sub = collectSubagentMaps(transcriptPath, sessionId, limits);
    if (wantSystem) {
      items.push(...collectSystemPrompts(rawBodyDir, sessionId, limits, {
        agentCalls: scan.agentCalls,
        subagentScopes: sub?.scopes,
      }));
    }
    if (wantHooks) items.push(...scan.hookContexts);
    if (wantTools) {
      // 子 agent 归属映射跟工具输出同一开关:两者都是为了把子 agent 子树建出来。
      // 内部工具输出并进同一个 outputs 池,让全局上限与"优先保 Task 输出"一并生效。
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
      transcriptStartOffset: startOffset,
      transcriptNextOffset: scan && scan.nextOffset,
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
    return true;
  }

  const known = new Set(previous.hashes || []);
  const fresh = items.filter((item) => !known.has(item.hash));

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

  const allUploaded = uploaded.length === fresh.length;
  const nextState = {
    ...previous,
    hashes: [...known, ...uploaded.map((item) => item.hash)].slice(-500),
    updatedAt: new Date().toISOString(),
  };
  if (allUploaded && scan) {
    nextState.transcriptPath = transcriptPath;
    nextState.transcriptOffset = scan.nextOffset;
    nextState.agentToolIds = [...scan.agentToolIds].slice(-limits.subagentMapIds);
  }
  checkpoint.sessions[sessionId] = nextState;
  saveCheckpoint(file, checkpoint, limits);
  if (items.length === 0) log(`nothing to supplement for ${sessionId}`);
  else if (fresh.length === 0) log(`all ${items.length} items already uploaded for ${sessionId}`);
  return allUploaded;
}

async function readHookPayload() {
  const raw = await readStdin();
  try {
    return JSON.parse(raw || '{}');
  } catch {
    log('stdin is not JSON, skip');
    return null;
  }
}

async function handleSessionEnd(payload, options = {}) {
  const queueDir = options.queueDir || QUEUE_DIR;
  const queued = enqueuePayload(payload, { queueDir, spawnWorker: () => {} });
  if (!queued) {
    // 本地队列不可写时仍尽力直传;这是唯一绕过队列锁的降级路径。
    const ok = await (options.processPayload || uploadPayload)(payload);
    return { processed: ok ? 1 : 0, failed: ok ? 0 : 1, locked: false };
  }
  return drainQueue({ ...options, queueDir });
}

async function main() {
  const arg = process.argv[2];
  if (arg === '--install-hook') return installHook();
  if (arg === '--uninstall-hook') return uninstallHook();
  if (arg === '--drain-queue') return drainQueue();

  const payload = await readHookPayload();
  if (!payload) return;
  if (arg === '--enqueue') {
    enqueuePayload(payload);
    return;
  }
  if (arg === '--dry-run') return uploadPayload(payload, { dryRun: true });
  return handleSessionEnd(payload);
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
  installHook,
  uninstallHook,
  enqueuePayload,
  drainQueue,
  uploadPayload,
  handleSessionEnd,
};

if (require.main === module) {
  main().catch((err) => log(`fatal: ${err && err.message}`)).finally(() => process.exit(0));
}
