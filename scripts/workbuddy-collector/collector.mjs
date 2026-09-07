/**
 * WorkBuddy Trace Collector —— 独立常驻进程。
 *
 * 职责：监听 ~/.workbuddy/traces/<pid>/trace_*.json 新文件 → 关联 sessionId（Session
 * Registry）→ 只读查询 workbuddy.db 补全 mode/model/会话级 token 快照 → 映射为 canonical
 * events → 写入共享 spool → 触发上传。与 WorkBuddy 进程完全解耦，互不影响。
 *
 * 运行：node collector.mjs   （由 workbuddy_setup.mjs 注册的计划任务在登录时自动拉起）
 * 配置优先级：CLI/env > ~/.agent-insight/otel_data/workbuddy/config.json
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { SessionRegistry, defaultSessionsDir } from "./session-registry.mjs";

const require = createRequire(import.meta.url);
const {
  DurableTraceWriter,
  DurableTraceUploader,
  acquireProcessLock,
  releaseProcessLock,
  apiKeyHash,
} = require("../agent-trace-collectors/shared/trace-transport.cjs");
const { FRAMEWORK, mapWorkBuddyTrace } = require("./mapper.cjs");
const { extractSendPrompts, pickPromptForTrace } = require("./sdk-log.cjs");

const logger = console;

/**
 * 从 SDK 会话日志（D3）读取该轮真实用户输入（干净、未截断）。
 * trace 的 toolInput 会被 WorkBuddy 截断在 ~100KB，长对话时当前轮提问会丢失，
 * 因此优先用 D3 的 userContent，按 trace 起始时间关联到对应轮次。
 */
async function readUserPromptFromSdkLog(wbHome, sessionId, traceStartMs) {
  try {
    const logsRoot = path.join(wbHome, "logs");
    const dates = await fsp.readdir(logsRoot).catch(() => []);
    let combined = "";
    for (const date of dates) {
      const p = path.join(logsRoot, date, "sdk", "conversations", `${sessionId}.log`);
      try { combined += await fsp.readFile(p, "utf8"); } catch { /* 该日期下无此会话日志 */ }
    }
    if (!combined) return undefined;
    return pickPromptForTrace(extractSendPrompts(combined), traceStartMs);
  } catch {
    return undefined;
  }
}

function workbuddyHome(homeDir = os.homedir()) {
  return path.join(homeDir, ".workbuddy");
}

function collectorStateRoot(homeDir = os.homedir()) {
  return path.join(homeDir, ".agent-insight", "otel_data", FRAMEWORK);
}

async function loadConfig(homeDir = os.homedir()) {
  const configPath = path.join(collectorStateRoot(homeDir), "config.json");
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(await fsp.readFile(configPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") logger.warn(`[workbuddy] config read failed: ${error?.message}`);
  }
  const endpoint = process.env.AGENT_INSIGHT_OTLP_ENDPOINT || fileConfig.endpoint;
  const apiKey = process.env.AGENT_INSIGHT_API_KEY || fileConfig.apiKey;
  if (!endpoint || !apiKey) {
    throw new Error(
      "缺少 endpoint 或 apiKey。请通过 workbuddy_setup.mjs 安装，或设置 " +
      "AGENT_INSIGHT_OTLP_ENDPOINT / AGENT_INSIGHT_API_KEY 环境变量。",
    );
  }
  return { endpoint, apiKey };
}

/** 只读查询 workbuddy.db（best-effort）：mode / model / session_usage 快照。node:sqlite 不可用时降级为空。 */
async function readSessionEnrichment(dbPath, sessionId) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    return {}; // 运行时无 node:sqlite（Node < 22.5）→ 降级，不阻塞采集
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    logger.warn?.(`[workbuddy] sqlite open failed (skip enrichment): ${error?.message}`);
    return {};
  }
  try {
    const out = {};
    try {
      const row = db.prepare("SELECT used, size FROM session_usage WHERE session_id = ?").get(sessionId);
      if (row) out.sessionTotals = { used: Number(row.used), size: Number(row.size) };
    } catch { /* schema 变化 → 该字段缺失即降级 */ }
    try {
      const row = db.prepare("SELECT mode, model FROM sessions WHERE id = ?").get(sessionId);
      if (row) {
        out.mode = row.mode || undefined;
        out.model = row.model || undefined;
      }
    } catch { /* 同上 */ }
    return out;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/** 等待文件 mtime 静止（防止读到半写文件）。 */
async function waitForStableFile(filePath, { quietMs = 200, maxWaitMs = 5000 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  let lastSize = -1;
  let lastMtime = -1;
  while (Date.now() < deadline) {
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return false;
    }
    if (stat.size === lastSize && stat.mtimeMs === lastMtime && stat.size > 0) return true;
    lastSize = stat.size;
    lastMtime = stat.mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, quietMs));
  }
  return true;
}

function pidFromTracePath(tracePath) {
  const parent = path.basename(path.dirname(tracePath));
  return /^\d+$/.test(parent) ? Number(parent) : null;
}

export class WorkBuddyCollector {
  constructor(options = {}) {
    this.homeDir = options.homeDir || os.homedir();
    this.wbHome = options.workbuddyHome || workbuddyHome(this.homeDir);
    this.tracesDir = path.join(this.wbHome, "traces");
    this.dbPath = path.join(this.wbHome, "workbuddy.db");
    this.stateRoot = collectorStateRoot(this.homeDir);
    this.endpoint = options.endpoint;
    this.apiKey = options.apiKey;
    this.registry = new SessionRegistry({
      sessionsDir: defaultSessionsDir(this.homeDir),
      cachePath: path.join(this.stateRoot, "session-registry.json"),
      logger,
    });
    // 编码 Agent 的文件路径是观测核心信号（Read/Write/Edit/Bash 的对象），且属自托管自查场景，
    // 关闭本地路径脱敏（密钥/token/邮箱等敏感信息仍照常脱敏）。
    this.writer = new DurableTraceWriter({
      framework: FRAMEWORK,
      apiKey: this.apiKey,
      homeDir: this.homeDir,
      redactLocalPaths: false,
    });
    this.uploader = new DurableTraceUploader({
      framework: FRAMEWORK,
      apiKey: this.apiKey,
      endpoint: this.endpoint,
      homeDir: this.homeDir,
      redactLocalPaths: false,
    });
    this.processedPath = path.join(this.stateRoot, apiKeyHash(this.apiKey), "processed-traces.json");
    this.processed = new Set();
    this.lock = null;
    this.watcher = null;
    this.queue = Promise.resolve();
  }

  async start() {
    this.lock = await acquireProcessLock(path.join(this.stateRoot, "collector.lock"));
    if (!this.lock) {
      logger.info("[workbuddy] 另一个采集器实例已在运行，本进程退出。");
      return false;
    }
    await this._loadProcessed().catch(() => {});
    await this.registry.start();
    await fsp.mkdir(this.tracesDir, { recursive: true }).catch(() => {});

    // 启动补采：处理已存在但未处理过的 trace 文件。
    await this._scanExisting().catch((error) => logger.warn(`[workbuddy] initial scan failed: ${error?.message}`));

    try {
      this.watcher = fs.watch(this.tracesDir, { persistent: true, recursive: true }, (_type, filename) => {
        if (!filename) return;
        const normalized = String(filename).replace(/\\/g, "/");
        if (!/trace_[^/]+\.json$/.test(normalized)) return;
        const full = path.join(this.tracesDir, filename);
        this._enqueue(full);
      });
    } catch (error) {
      logger.warn(`[workbuddy] recursive watch unavailable: ${error?.message}; 依赖周期扫描`);
    }
    this.scanTimer = setInterval(() => {
      this._scanExisting().catch(() => {});
    }, 60 * 1000);
    this.scanTimer.unref?.();
    this.uploader.start(5 * 60 * 1000);
    logger.info(`[workbuddy] 采集器已启动，监听 ${this.tracesDir}`);
    return true;
  }

  async stop() {
    this.watcher?.close?.();
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.uploader.stop();
    this.registry.stop();
    await this.writer.flush().catch(() => {});
    await releaseProcessLock(this.lock).catch(() => {});
  }

  _enqueue(tracePath) {
    this.queue = this.queue.then(() => this._handleTrace(tracePath).catch((error) => {
      logger.warn(`[workbuddy] handle ${tracePath} failed: ${error?.message}`);
    }));
    return this.queue;
  }

  async _scanExisting() {
    let pidDirs;
    try {
      pidDirs = await fsp.readdir(this.tracesDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const dir of pidDirs) {
      if (!dir.isDirectory()) continue;
      const dirPath = path.join(this.tracesDir, dir.name);
      let files;
      try {
        files = await fsp.readdir(dirPath);
      } catch {
        continue;
      }
      for (const file of files) {
        if (/^trace_.+\.json$/.test(file)) this._enqueue(path.join(dirPath, file));
      }
    }
  }

  async _handleTrace(tracePath) {
    const key = path.relative(this.tracesDir, tracePath).replace(/\\/g, "/");
    if (this.processed.has(key)) return;
    const stable = await waitForStableFile(tracePath);
    if (!stable) return;

    let doc;
    try {
      doc = JSON.parse(await fsp.readFile(tracePath, "utf8"));
    } catch (error) {
      logger.warn(`[workbuddy] parse ${key} failed (will retry next scan): ${error?.message}`);
      return; // 不标记 processed，下一轮重试
    }

    const pid = pidFromTracePath(tracePath);
    const resolved = pid !== null ? this.registry.resolve(pid) : undefined;
    let sessionId = resolved?.sessionId;
    let sessionResolution = "exact";
    if (!sessionId) {
      // 兜底：心跳已失且缓存未命中 —— 用 workerPid+hostname+startedAt 拼降级 key，不丢数据。
      const wp = doc?.trace?.workerPid ?? pid ?? "unknown";
      const host = doc?.trace?.workerHostname || os.hostname();
      sessionId = `wb-degraded-${host}-${wp}-${doc?.trace?.traceId || key}`;
      sessionResolution = "degraded";
    }

    const enrichment = await readSessionEnrichment(this.dbPath, sessionId).catch(() => ({}));
    // 优先用 D3（SDK 会话日志）里干净、未截断的用户输入；D3 拿不到时 mapper 回退 toolInput。
    const traceStartMs = Date.parse(doc?.trace?.startedAt) || undefined;
    const userPrompt = sessionResolution === "exact"
      ? await readUserPromptFromSdkLog(this.wbHome, sessionId, traceStartMs)
      : undefined;
    const events = mapWorkBuddyTrace(doc, {
      sessionId,
      mode: enrichment.mode || resolved?.mode,
      workbuddyVersion: resolved?.version,
      sessionTotals: enrichment.sessionTotals,
      sessionResolution,
      userPrompt,
    });

    for (const event of events) await this.writer.append(event);
    await this.writer.flush();
    await this._markProcessed(key);
    // trace 落盘即上传，粒度更细更及时。
    await this.uploader.flushOnce().catch((error) => {
      logger.warn(`[workbuddy] upload failed (spooled, will retry): ${error?.message}`);
    });
  }

  async _loadProcessed() {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.processedPath, "utf8"));
      if (Array.isArray(parsed?.keys)) for (const k of parsed.keys) this.processed.add(k);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async _markProcessed(key) {
    this.processed.add(key);
    await fsp.mkdir(path.dirname(this.processedPath), { recursive: true, mode: 0o700 });
    // 只保留最近 5000 条，避免无界增长。
    const keys = Array.from(this.processed).slice(-5000);
    this.processed = new Set(keys);
    const tmp = `${this.processedPath}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ version: 1, keys }), "utf8");
    await fsp.rename(tmp, this.processedPath);
  }
}

async function main() {
  const { endpoint, apiKey } = await loadConfig();
  const collector = new WorkBuddyCollector({ endpoint, apiKey });
  const started = await collector.start();
  if (!started) process.exit(0);
  const shutdown = async () => {
    await collector.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// 直接运行时启动；被 import 时仅导出类，便于测试。
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("collector.mjs")) {
  main().catch((error) => {
    logger.error(`[workbuddy] 启动失败: ${error?.message}`);
    process.exit(1);
  });
}
