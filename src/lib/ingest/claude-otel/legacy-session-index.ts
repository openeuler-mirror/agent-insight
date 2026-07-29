/**
 * 旧格式整日 spool 文件的 sessionId → byte-range 旁路索引。
 *
 * 背景:2026-06-17(1aac8d3)把写入改成 `<day>/sessions/<session>/*.jsonl` 分片之前,所有
 * 会话都写在 `<day>/logs.jsonl` / `<day>/traces.jsonl` 里。分片之后新数据能按 session 定位,
 * 但这些历史整日文件里可能还有跨格式边界会话的早期 span,不能直接丢掉 —— 于是每聚合一条
 * trace 都要把整日大文件从头扫一遍,成本 = session 数 × legacy 总字节数。
 *
 * 这里给每个 legacy 文件建一份旁路索引,一份文件只线性扫一次,之后按 byte range 定点读:
 *   - 追加 → 只索引新增字节(indexedBytes 之后那段)
 *   - 截断/替换/索引损坏 → 安全重建,不抛错
 *   - 原始 spool 一个字节都不动;索引删掉会自动重建
 *
 * 索引文件后缀是 `.json` 而不是 `.jsonl` —— spool 的文件发现(listJsonlSpoolFiles /
 * checkpoint.listJsonlFiles)只认 `.jsonl`,所以旁路索引不会被当成待消费数据。改名前先想清楚。
 */
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const READ_CHUNK_BYTES = 1024 * 1024;

/**
 * 相邻区间间隔小于这个值就合并:少读一点多余字节,换索引体积。
 *
 * 取一个页大小而不是更大的值 —— legacy 整日文件里几十个会话是**交错**写的,同一会话相邻两行
 * 往往隔十几 KB。阈值一大(试过 64KB)所有区间会并成一整块,索引等于白建、还是全文件扫。
 * 4KB 既能把同一会话的连续批次并起来,又不会跨过别的会话。
 */
const COALESCE_GAP_BYTES = 4 * 1024;

/**
 * 单个会话的区间数上限。超了就并进最后一个区间(读多一点,仍然正确),
 * 避免病态交错的文件把索引撑成几十 MB。
 */
const MAX_RANGES_PER_SESSION = 4096;

const INDEX_SUFFIX = '.session-index-v1.json';

type Range = [offset: number, length: number];

type LegacySessionIndex = {
  version: 1;
  indexedBytes: number;
  sessions: Record<string, Range[]>;
};

type CacheEntry = {
  size: number;
  mtimeMs: number;
  index: LegacySessionIndex;
};

/** 进程内缓存:避免每次聚合都重新 parse 索引 JSON。按 (size, mtimeMs) 失效。 */
const cache = new Map<string, CacheEntry>();

export function legacySessionIndexPath(file: string): string {
  return `${file}${INDEX_SUFFIX}`;
}

export function isLegacySessionIndexPath(file: string): boolean {
  return file.endsWith(INDEX_SUFFIX);
}

export function invalidateLegacySessionIndexCache(file?: string): void {
  if (file === undefined) cache.clear();
  else cache.delete(file);
}

function emptyIndex(): LegacySessionIndex {
  return { version: 1, indexedBytes: 0, sessions: {} };
}

function loadPersistedIndex(file: string): LegacySessionIndex {
  try {
    const parsed = JSON.parse(fs.readFileSync(legacySessionIndexPath(file), 'utf8'));
    if (parsed?.version === 1 && parsed.sessions && typeof parsed.sessions === 'object'
      && Number.isFinite(parsed.indexedBytes)) {
      return { version: 1, indexedBytes: parsed.indexedBytes, sessions: parsed.sessions };
    }
  } catch {
    // 不存在/损坏/版本不符 → 重建。索引是可再生的旁路数据,任何异常都不该影响读取正确性。
  }
  return emptyIndex();
}

function persistIndex(file: string, index: LegacySessionIndex): void {
  const target = legacySessionIndexPath(file);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(index), 'utf8');
    fs.renameSync(temp, target);
  } catch {
    try { fs.unlinkSync(temp); } catch {}
  }
}

function appendRange(ranges: Range[], offset: number, length: number): void {
  const last = ranges[ranges.length - 1];
  if (last && (offset - (last[0] + last[1]) <= COALESCE_GAP_BYTES || ranges.length >= MAX_RANGES_PER_SESSION)) {
    last[1] = offset + length - last[0];
    return;
  }
  ranges.push([offset, length]);
}

/**
 * 从 index.indexedBytes 起扫到 size,把新增部分补进索引。
 * 只推进到最后一条**完整**行:末行写了一半时下次再补,天然处理多字节 UTF-8 和写入中途。
 */
function indexTail(file: string, index: LegacySessionIndex, size: number): void {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return;
  }

  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const decoder = new StringDecoder('utf8');
  let offset = index.indexedBytes;
  let lineStart = offset;
  let pending = '';

  try {
    while (offset < size) {
      const bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
      pending += decoder.write(buffer.subarray(0, bytesRead));
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';

      for (const line of lines) {
        const length = Buffer.byteLength(line, 'utf8') + 1;
        if (line.trim()) {
          let sessionId: unknown;
          try {
            sessionId = JSON.parse(line)?.sessionId;
          } catch {
            sessionId = undefined;
          }
          if (typeof sessionId === 'string' && sessionId) {
            appendRange((index.sessions[sessionId] ||= []), lineStart, length);
          }
        }
        lineStart += length;
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  index.indexedBytes = lineStart;
}

function getIndex(file: string): LegacySessionIndex | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }

  const cached = cache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.index;

  let index = cached?.index ?? loadPersistedIndex(file);
  // 文件比索引还短 = 被截断或整体替换过,旧的 offset 全部作废。
  if (index.indexedBytes > stat.size) index = emptyIndex();

  if (index.indexedBytes < stat.size) {
    indexTail(file, index, stat.size);
    persistIndex(file, index);
  }

  let mtimeMs = stat.mtimeMs;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch {}
  cache.set(file, { size: stat.size, mtimeMs, index });
  return index;
}

/**
 * 按索引定点读取某个 session 在 legacy 整日文件里的事件。
 * 区间合并允许覆盖少量别的 session 的行,所以读回来仍要按 sessionId 过滤一次。
 */
export function readLegacyEventsForSession<T = any>(file: string, sessionId: string): T[] {
  const index = getIndex(file);
  if (!index) return [];
  const ranges = index.sessions[sessionId];
  if (!ranges || !ranges.length) return [];

  const events: T[] = [];
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return events;
  }

  try {
    for (const [offset, length] of ranges) {
      const buffer = Buffer.allocUnsafe(length);
      let bytesRead = 0;
      try {
        bytesRead = fs.readSync(fd, buffer, 0, length, offset);
      } catch {
        continue;
      }
      for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event?.sessionId === sessionId) events.push(event);
        } catch {}
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  return events;
}

/** 删除某个 legacy 文件的旁路索引(retention 归档原文件时调用)。 */
export function removeLegacySessionIndex(file: string): void {
  cache.delete(file);
  try { fs.unlinkSync(legacySessionIndexPath(file)); } catch {}
}
