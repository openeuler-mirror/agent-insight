/**
 * WorkBuddy Session Registry —— 持续订阅 ~/.workbuddy/sessions/<pid>.json 心跳文件，
 * 维护 pid → sessionId 的缓存。
 *
 * 为什么需要它：sessions/<pid>.json 在会话结束后会被 WorkBuddy 清理，如果采集器
 * 等到 trace 文件出现才去查心跳，很可能已经查不到。所以这里做「持续订阅 + 宽限期」：
 * 心跳出现即缓存，心跳被删只打「已结束」标记并保留一段 TTL 再淘汰，避免
 * 「心跳先清理、trace 后落盘」的乱序丢失。缓存镜像落盘，采集器重启后可恢复。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_GRACE_MS = 10 * 60 * 1000; // 心跳消失后保留 10 分钟

export class SessionRegistry {
  /**
   * @param {object} options
   *   - sessionsDir {string}  ~/.workbuddy/sessions
   *   - cachePath   {string}  缓存镜像文件路径
   *   - graceMs     {number=} 心跳消失后的宽限期
   *   - logger      {object=} { info, warn }
   */
  constructor(options) {
    this.sessionsDir = options.sessionsDir;
    this.cachePath = options.cachePath;
    this.graceMs = options.graceMs || DEFAULT_GRACE_MS;
    this.logger = options.logger || console;
    /** @type {Map<string, { sessionId, mode, version, cwd, endedAt: number|null }>} */
    this.byPid = new Map();
    this.watcher = null;
  }

  async start() {
    await this._loadCache().catch(() => {});
    await fsp.mkdir(this.sessionsDir, { recursive: true }).catch(() => {});
    // 启动时先全量扫描重建缓存，再进入订阅，减少重启窗口期丢失。
    await this._scanAll().catch((error) => this.logger.warn?.(`[session-registry] scan failed: ${error?.message}`));
    try {
      this.watcher = fs.watch(this.sessionsDir, { persistent: true }, (_eventType, filename) => {
        if (!filename) return;
        const pid = this._pidFromFilename(String(filename));
        if (pid === null) return;
        this._refreshPid(pid).catch((error) => this.logger.warn?.(`[session-registry] refresh ${pid} failed: ${error?.message}`));
      });
    } catch (error) {
      this.logger.warn?.(`[session-registry] watch unavailable, falling back to periodic scan: ${error?.message}`);
    }
    // 兜底周期扫描（watch 在部分环境不可靠），同时执行宽限期淘汰。
    this.timer = setInterval(() => {
      this._scanAll().catch(() => {});
      this._evictExpired();
    }, 30 * 1000);
    this.timer.unref?.();
  }

  stop() {
    this.watcher?.close?.();
    this.watcher = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 解析 pid → 会话信息。命中缓存（含宽限期内的已结束会话）即返回；否则返回 undefined。
   */
  resolve(pid) {
    const entry = this.byPid.get(Number(pid));
    if (!entry) return undefined;
    return { sessionId: entry.sessionId, mode: entry.mode, version: entry.version, cwd: entry.cwd };
  }

  _pidFromFilename(filename) {
    const match = /^(\d+)\.json$/.exec(filename);
    return match ? Number(match[1]) : null;
  }

  async _refreshPid(pid) {
    const file = path.join(this.sessionsDir, `${pid}.json`);
    let raw;
    try {
      raw = await fsp.readFile(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        // 心跳被清理：打「已结束」标记，宽限期后再淘汰。
        const entry = this.byPid.get(pid);
        if (entry && entry.endedAt === null) {
          entry.endedAt = Date.now();
          await this._persistCache().catch(() => {});
        }
        return;
      }
      throw error;
    }
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch {
      return; // 半写文件，下一轮再读
    }
    const sessionId = doc?.sessionId;
    if (!sessionId) return;
    this.byPid.set(pid, {
      sessionId,
      mode: doc.mode,
      version: doc.version,
      cwd: doc.cwd,
      endedAt: null,
    });
    await this._persistCache().catch(() => {});
  }

  async _scanAll() {
    let entries;
    try {
      entries = await fsp.readdir(this.sessionsDir);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    const alivePids = new Set();
    for (const name of entries) {
      const pid = this._pidFromFilename(name);
      if (pid === null) continue;
      alivePids.add(pid);
      await this._refreshPid(pid);
    }
    // 目录里已消失但缓存还在的 pid：标记已结束（若尚未标记）。
    for (const [pid, entry] of this.byPid) {
      if (!alivePids.has(pid) && entry.endedAt === null) {
        entry.endedAt = Date.now();
      }
    }
    await this._persistCache().catch(() => {});
  }

  _evictExpired() {
    const now = Date.now();
    let changed = false;
    for (const [pid, entry] of this.byPid) {
      if (entry.endedAt !== null && now - entry.endedAt > this.graceMs) {
        this.byPid.delete(pid);
        changed = true;
      }
    }
    if (changed) this._persistCache().catch(() => {});
  }

  async _loadCache() {
    const raw = await fsp.readFile(this.cachePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || typeof parsed.byPid !== "object") return;
    for (const [pid, entry] of Object.entries(parsed.byPid)) {
      if (entry?.sessionId) this.byPid.set(Number(pid), { endedAt: null, ...entry });
    }
  }

  async _persistCache() {
    const obj = { version: 1, byPid: {} };
    for (const [pid, entry] of this.byPid) obj.byPid[pid] = entry;
    await fsp.mkdir(path.dirname(this.cachePath), { recursive: true });
    const tmp = `${this.cachePath}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(obj), "utf8");
    await fsp.rename(tmp, this.cachePath);
  }
}

export function defaultSessionsDir(homeDir = os.homedir()) {
  return path.join(homeDir, ".workbuddy", "sessions");
}
