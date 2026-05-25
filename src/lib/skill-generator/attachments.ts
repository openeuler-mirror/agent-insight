import fs from 'node:fs';
import path from 'node:path';
import { ensureSessionWorkspace } from '@/lib/engine/general-agent/workspace';
import { ALLOWED_EXT } from './file-types';

/**
 * Playground 附件管理：把用户上传的参考资料平铺到 `<workspace>/uploads/`，
 * 让 skill-generator agent 用内置 read 工具就能直接读。
 *
 * 设计要点：
 *  - 不进 DB；附件就是工作区里的文件，weave 进 thread 的生命周期里
 *  - PDF / docx 上传时同步转 `.txt` 副本（不删原文件——用户还要下载），
 *    喂给 agent 读的永远是 txt（opencode 的 read 工具不识别二进制）
 *  - 文件名 sanitize 防路径穿越；冲突时尾缀 `-N`
 *  - VFS 扫描 / 下载 zip 必须排除 `uploads/`（在 bridge 里）
 */

export const UPLOADS_DIR = 'uploads';

export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_FILES_PER_THREAD = 50;
export const MAX_FILES_PER_REQUEST = 10;

export interface AttachmentItem {
  name: string;
  size: number;
  /** 相对 workspace 根的路径，例如 `uploads/api-spec.pdf` */
  relPath: string;
  /** 若上传的是 PDF/docx，这里是同目录的 `.txt` 副本路径；agent 应该读这个 */
  textRelPath?: string;
  /** 原始 mime；目前仅用作 UI 展示 */
  mime?: string;
  mtimeMs: number;
}

function uploadsDirFor(user: string, threadId: string): string {
  const workspaceDir = ensureSessionWorkspace(user, threadId);
  const dir = path.join(workspaceDir, UPLOADS_DIR);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeFilename(name: string): string {
  // 去掉路径分量，只保留 basename，再过滤危险字符
  const base = path.basename(name).replace(/[^A-Za-z0-9._-]/g, '_');
  // 不允许以 `.` 开头（隐藏文件）
  const noLeadingDot = base.replace(/^\.+/, '');
  return noLeadingDot.slice(0, 80) || 'unnamed';
}

/** 同目录已有同名文件时，加 `-1`/`-2` 直到不冲突 */
function uniqueFilenameIn(dir: string, desired: string): string {
  if (!fs.existsSync(path.join(dir, desired))) return desired;
  const ext = path.extname(desired);
  const stem = desired.slice(0, desired.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  // 兜底：用时间戳，几乎一定唯一
  return `${stem}-${Date.now()}${ext}`;
}

function detectMime(name: string): string | undefined {
  const ext = path.extname(name).toLowerCase();
  return {
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.txt': 'text/plain',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.xml': 'application/xml',
  }[ext] || 'text/plain';
}

/**
 * 把上传的 PDF / docx 转成同目录的 `.txt`。
 * 失败时返回 null——上层会保留原文件并告诉 agent "这个二进制读不出来"。
 */
async function extractTextSidecar(filePath: string): Promise<string | null> {
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === '.pdf') {
      // pdf-parse 是 CommonJS 包且没出 .d.ts，用 // @ts-ignore + 动态 import 兜过 TS。
      // @ts-ignore - no types ship with pdf-parse
      const pdfParseMod: any = await import('pdf-parse');
      const pdfParse = pdfParseMod.default || pdfParseMod;
      const buf = fs.readFileSync(filePath);
      const result = await pdfParse(buf);
      return (result?.text || '').trim() || null;
    }
    if (ext === '.docx') {
      const mammoth = await import('mammoth');
      const buf = fs.readFileSync(filePath);
      const result = await mammoth.extractRawText({ buffer: buf });
      return (result.value || '').trim() || null;
    }
  } catch (err) {
    console.warn('[attachments] text extract failed for', filePath, (err as Error)?.message);
  }
  return null;
}

export interface SavedFile {
  /** 原始文件名（已 sanitize、冲突避让后的最终名） */
  name: string;
  /** 已写入磁盘的绝对路径 */
  absPath: string;
  bytes: number;
}

export interface SaveError {
  name: string;
  reason: string;
}

/**
 * 把一次 multipart 上传的多个 File 全部落到 `<workspace>/uploads/`。
 * 返回成功落盘的列表与失败原因。失败原因包括：大小超限 / 类型不允许 / IO 失败。
 *
 * 注意：此函数不做 PDF/docx 转 txt——转换走 `materializeTextSidecars()`，
 * 让 caller 决定是否等待（route handler 是 async，可以等；测试里可以跳过）。
 */
export async function saveUploadedFiles(
  user: string,
  threadId: string,
  files: File[],
): Promise<{ saved: SavedFile[]; errors: SaveError[] }> {
  if (files.length > MAX_FILES_PER_REQUEST) {
    return {
      saved: [],
      errors: [{ name: '(request)', reason: `一次最多上传 ${MAX_FILES_PER_REQUEST} 个文件` }],
    };
  }

  const dir = uploadsDirFor(user, threadId);
  const existingCount = fs.readdirSync(dir).filter(n => !n.startsWith('.')).length;
  if (existingCount + files.length > MAX_FILES_PER_THREAD) {
    return {
      saved: [],
      errors: [{
        name: '(quota)',
        reason: `当前会话已有 ${existingCount} 个附件，加上本次将超过上限 ${MAX_FILES_PER_THREAD}`,
      }],
    };
  }

  const saved: SavedFile[] = [];
  const errors: SaveError[] = [];

  for (const file of files) {
    const originalName = file.name || 'unnamed';
    const ext = path.extname(originalName).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      errors.push({ name: originalName, reason: `不支持的文件类型: ${ext || '(无扩展名)'}` });
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      errors.push({ name: originalName, reason: `文件超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 上限` });
      continue;
    }
    const safeName = uniqueFilenameIn(dir, sanitizeFilename(originalName));
    const abs = path.join(dir, safeName);
    try {
      const buf = Buffer.from(await file.arrayBuffer());
      fs.writeFileSync(abs, buf);
      saved.push({ name: safeName, absPath: abs, bytes: buf.length });
    } catch (err) {
      errors.push({ name: originalName, reason: (err as Error)?.message || 'write failed' });
    }
  }
  return { saved, errors };
}

/**
 * 对刚 saved 的 PDF/docx 同步生成 `.txt` 副本。
 * 返回每个 saved 文件对应的 text 路径（没生成的为 null）。
 */
export async function materializeTextSidecars(
  saved: SavedFile[],
): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  await Promise.all(
    saved.map(async (f) => {
      const ext = path.extname(f.name).toLowerCase();
      if (ext !== '.pdf' && ext !== '.docx') {
        result[f.name] = null;
        return;
      }
      const text = await extractTextSidecar(f.absPath);
      if (!text) {
        result[f.name] = null;
        return;
      }
      const txtName = f.name.slice(0, f.name.length - ext.length) + '.txt';
      const txtAbs = path.join(path.dirname(f.absPath), txtName);
      try {
        fs.writeFileSync(txtAbs, text, 'utf-8');
        result[f.name] = txtName;
      } catch (err) {
        console.warn('[attachments] write sidecar failed:', (err as Error)?.message);
        result[f.name] = null;
      }
    }),
  );
  return result;
}

/** 列出当前 thread workspace 里 uploads/ 下的所有附件（不含 .txt 副本） */
export function listAttachments(user: string, threadId: string): AttachmentItem[] {
  const dir = uploadsDirFor(user, threadId);
  const items: AttachmentItem[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  // 先扫一遍找出 `.txt` 副本所对应的原文件名，避免把副本作为独立项目列出来
  const sidecarOf = new Map<string, string>(); // stem -> txt name
  for (const n of names) {
    if (n.endsWith('.txt')) {
      const stem = n.slice(0, -4);
      sidecarOf.set(stem, n);
    }
  }
  for (const n of names) {
    if (n.startsWith('.')) continue;
    const ext = path.extname(n).toLowerCase();
    // 如果这个 .txt 是某个 .pdf/.docx 的副本，跳过
    if (ext === '.txt') {
      const stem = n.slice(0, -4);
      if (names.some(o => (o === stem + '.pdf' || o === stem + '.docx'))) continue;
    }
    const abs = path.join(dir, n);
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (!stat.isFile()) continue;
    const sidecar = sidecarOf.get(n.slice(0, n.length - ext.length));
    items.push({
      name: n,
      size: stat.size,
      relPath: `${UPLOADS_DIR}/${n}`,
      textRelPath: sidecar ? `${UPLOADS_DIR}/${sidecar}` : undefined,
      mime: detectMime(n),
      mtimeMs: stat.mtimeMs,
    });
  }
  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return items;
}

/** 删除指定附件（连带 .txt 副本） */
export function deleteAttachment(user: string, threadId: string, name: string): boolean {
  const safe = sanitizeFilename(name);
  if (safe !== name) return false; // 拒绝任何与 sanitize 后不一致的输入
  const dir = uploadsDirFor(user, threadId);
  const abs = path.join(dir, name);
  if (!abs.startsWith(dir + path.sep) && abs !== dir) return false;
  let ok = false;
  try {
    if (fs.existsSync(abs)) { fs.unlinkSync(abs); ok = true; }
  } catch (err) {
    console.warn('[attachments] delete failed:', (err as Error)?.message);
  }
  const ext = path.extname(name).toLowerCase();
  if (ext === '.pdf' || ext === '.docx') {
    const txt = name.slice(0, name.length - ext.length) + '.txt';
    const txtAbs = path.join(dir, txt);
    try { if (fs.existsSync(txtAbs)) fs.unlinkSync(txtAbs); } catch { /* ignore */ }
  }
  return ok;
}

/** 给 system prompt 拼一段"附件清单"片段。空列表返回空串。 */
export function formatAttachmentsForPrompt(items: AttachmentItem[]): string {
  if (items.length === 0) return '';
  const lines = items.map(it => {
    const target = it.textRelPath || it.relPath;
    const note = it.textRelPath ? `（原文件 ${it.relPath}，已转纯文本）` : '';
    return `- ./${target}${note}`;
  });
  return [
    '## 用户上传的参考资料（./uploads/，只读）',
    '需要时用 `read` 工具读取以下文件；不要写入或修改 uploads/ 目录。',
    '',
    ...lines,
    '',
  ].join('\n');
}
