/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import AdmZip from 'adm-zip';
import matter from 'gray-matter';
import { resolveAgentInsightDataPath } from '@/lib/env';
import type { EvaluatorSkillBinding, EvaluatorSkillFileInfo, EvaluatorSkillSource } from './evaluator-skills';

export const SKILL_PACKAGE_LIMIT = 10 * 1024 * 1024;
export const SKILL_FILE_LIMIT = 256;
export const SKILL_INSTRUCTION_LIMIT = 64 * 1024;
const IMPORT_TTL = 24 * 60 * 60 * 1000;
export interface SkillPackageFile { path: string; data: Buffer; executable?: boolean }
interface StoredFile extends EvaluatorSkillFileInfo { sha256: string }
interface Manifest { name: string; files: StoredFile[]; hash: string; expiresAt?: number; originalFileName?: string }

export class EvaluatorSkillError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = 'EvaluatorSkillError'; }
}
const fail = (message: string): never => { throw new EvaluatorSkillError(message); };
const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

export function previewSkillFiles(files: SkillPackageFile[], relative?: string | null) {
  if (!relative) return { files: files.map(f => ({ path: f.path, size: f.data.length, executable: Boolean(f.executable) })) };
  const file = files.find(f => f.path === skillRelativePath(relative));
  if (!file) throw new EvaluatorSkillError('文件不存在', 404);
  const isText = !file.data.includes(0) && !/\.(png|jpg|jpeg|gif|webp|pdf|zip|woff2?|xlsx|docx)$/i.test(file.path);
  return { path: file.path, size: file.data.length, isText, content: isText ? file.data.subarray(0, 512 * 1024).toString('utf8') : undefined, truncated: isText && file.data.length > 512 * 1024 };
}

export function skillRelativePath(value: string): string {
  if (!value || value.length > 512 || /[\\\x00-\x1f:]/.test(value) || value.startsWith('/')
    || value.split('/').some(p => !p || p === '.' || p === '..')) fail('Skill 文件路径无效');
  return value;
}

export function normalizeSkillPackage(input: SkillPackageFile[]): { name: string; files: SkillPackageFile[] } {
  if (!input.length || input.length > SKILL_FILE_LIMIT) fail(`Skill 最多包含 ${SKILL_FILE_LIMIT} 个文件`);
  let files = input.map(f => ({ ...f, path: skillRelativePath(f.path), executable: Boolean(f.executable) }));
  if (!files.some(f => f.path === 'SKILL.md')) {
    const first = files[0].path.split('/')[0];
    if (files.every(f => f.path.startsWith(`${first}/`)) && files.some(f => f.path === `${first}/SKILL.md`)) {
      files = files.map(f => ({ ...f, path: f.path.slice(first.length + 1) }));
    }
  }
  const seen = new Set<string>();
  let bytes = 0;
  for (const file of files) {
    const key = file.path.normalize('NFC').toLowerCase();
    if (seen.has(key)) fail(`Skill 文件名重复：${file.path}`);
    seen.add(key);
    bytes += file.data.length;
    if (bytes > SKILL_PACKAGE_LIMIT) fail('Skill 解压后的文件总量不能超过 10 MiB');
    if (file.path !== 'SKILL.md' && file.path.toLowerCase().endsWith('/skill.md')) fail('一次只能导入一个 Skill，检测到多个 Skill 根目录');
  }
  for (const file of files) {
    const parts = file.path.split('/');
    for (let n = 1; n < parts.length; n++) {
      if (seen.has(parts.slice(0, n).join('/').normalize('NFC').toLowerCase())) fail('Skill 文件与目录名称冲突');
    }
  }
  const main = files.find(f => f.path === 'SKILL.md') || fail('缺少根目录 SKILL.md');
  if (main.data.length > SKILL_INSTRUCTION_LIMIT) fail('Skill 主指令不能超过 64 KiB');
  let metadata: Record<string, unknown>;
  const frontmatter = main.data.toString('utf8').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) fail('SKILL.md 必须包含 YAML frontmatter');
  try { metadata = matter(`---\n${frontmatter![1]}\n---\n`).data; } catch { return fail('SKILL.md frontmatter 无效'); }
  const name = metadata.name;
  if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) fail('SKILL.md 必须包含有效 name（小写字母、数字和连字符，最多 64 字符）');
  return { name: name as string, files: files.sort((a, b) => a.path.localeCompare(b.path, 'en')) };
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function readSkillZip(data: Buffer): SkillPackageFile[] {
  if (data.length > SKILL_PACKAGE_LIMIT) fail('上传文件不能超过 10 MiB');
  try {
    const entries = new AdmZip(data).getEntries();
    if (entries.length > SKILL_FILE_LIMIT * 2) fail('ZIP 条目过多');
    const files: SkillPackageFile[] = [];
    let total = 0;
    for (const entry of entries) {
      skillRelativePath(entry.isDirectory ? entry.entryName.replace(/\/$/, '') : entry.entryName);
      const mode = (entry.attr >>> 16) & 0xffff;
      const kind = mode & 0xf000;
      if (kind && kind !== 0x8000 && kind !== 0x4000) fail('ZIP 不支持符号链接或特殊文件');
      if (entry.header.flags & 1) fail('不支持加密 ZIP');
      if (entry.isDirectory) continue;
      if (files.length >= SKILL_FILE_LIMIT || entry.header.size > SKILL_PACKAGE_LIMIT - total) fail('ZIP 解压后的文件数量或大小超限');
      const compressed = entry.getCompressedData();
      const bytes = entry.header.method === 0 ? compressed
        : entry.header.method === 8 ? inflateRawSync(compressed, { maxOutputLength: Math.max(1, SKILL_PACKAGE_LIMIT - total) })
          : fail('不支持该 ZIP 压缩格式');
      if (bytes.length !== entry.header.size || crc32(bytes) !== entry.header.crc) fail('ZIP 文件损坏');
      total += bytes.length;
      if (total > SKILL_PACKAGE_LIMIT) fail('ZIP 解压后的文件总量不能超过 10 MiB');
      files.push({ path: entry.entryName, data: bytes, executable: Boolean(mode & 0o111) });
    }
    return files;
  } catch (error) {
    if (error instanceof EvaluatorSkillError) throw error;
    throw new EvaluatorSkillError('ZIP 损坏、格式不受支持或解压后大小超限');
  }
}

export class EvaluatorSkillStore {
  constructor(private root = resolveAgentInsightDataPath(), private now = () => Date.now()) {}
  private userKey(user: string) { if (!user) fail('user is required'); return digest(user); }
  private directory(user: string, key: string, temporary = false) {
    if (!/^[a-f0-9]{64}$/.test(key)) fail('Skill 快照或导入凭证无效');
    return path.join(this.root, temporary ? 'evaluator-skill-imports' : 'evaluator-skills', this.userKey(user), key);
  }
  private async write(directory: string, manifest: Manifest, files: SkillPackageFile[]) {
    await fs.mkdir(path.dirname(directory), { recursive: true });
    const staging = `${directory}.staging-${randomBytes(8).toString('hex')}`;
    await fs.mkdir(staging);
    try {
      for (const file of files) {
        const target = path.join(staging, 'files', file.path);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, file.data, { mode: file.executable ? 0o700 : 0o600 });
      }
      await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest));
      try { await fs.rename(staging, directory); } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
      }
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
  }
  private manifest(name: string, files: SkillPackageFile[]): Manifest {
    const entries = files.map(f => ({ path: f.path, size: f.data.length, executable: Boolean(f.executable), sha256: digest(f.data) }));
    return { name, files: entries, hash: digest(JSON.stringify(entries)) };
  }
  async stage(user: string, input: SkillPackageFile[], originalFileName?: string) {
    await this.cleanExpired(user);
    const { name, files } = normalizeSkillPackage(input);
    const manifest = { ...this.manifest(name, files), expiresAt: this.now() + IMPORT_TTL, originalFileName: originalFileName?.split(/[\\/]/).pop()?.slice(0, 200) };
    const importToken = randomBytes(32).toString('hex');
    await this.write(this.directory(user, importToken, true), manifest, files);
    return { importToken, name, expiresAt: manifest.expiresAt, files: manifest.files.map(f => ({ path: f.path, size: f.size, executable: f.executable })) };
  }
  async load(user: string, key: string, temporary = false): Promise<{ manifest: Manifest; files: SkillPackageFile[] }> {
    const directory = this.directory(user, key, temporary);
    let manifest: Manifest;
    try { manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8')); }
    catch { throw new EvaluatorSkillError(temporary ? '导入不存在或已过期，请重新导入' : 'Skill 快照不存在或已损坏', 404); }
    if (temporary && (!manifest.expiresAt || manifest.expiresAt <= this.now())) throw new EvaluatorSkillError('导入已过期，请重新导入', 410);
    const files: SkillPackageFile[] = [];
    if (!Array.isArray(manifest.files) || manifest.files.length > SKILL_FILE_LIMIT) fail('Skill 文件清单无效');
    let totalBytes = 0;
    for (const entry of manifest.files) {
      const file = path.join(directory, 'files', skillRelativePath(entry.path));
      const stat = await fs.lstat(file).catch(() => null);
      if (!stat) throw new EvaluatorSkillError('Skill 快照文件缺失');
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== entry.size || stat.size > SKILL_PACKAGE_LIMIT) fail('Skill 快照文件缺失或已损坏');
      totalBytes += stat.size;
      if (totalBytes > SKILL_PACKAGE_LIMIT) fail('Skill 快照大小超限');
      const real = await fs.realpath(file);
      if (!real.startsWith(`${await fs.realpath(path.join(directory, 'files'))}${path.sep}`)) fail('Skill 文件路径越界');
      const data = await fs.readFile(file);
      if (digest(data) !== entry.sha256) fail('Skill 快照文件摘要不匹配');
      files.push({ path: entry.path, data, executable: entry.executable });
    }
    const normalized = normalizeSkillPackage(files);
    if (normalized.name !== manifest.name || this.manifest(normalized.name, normalized.files).hash !== manifest.hash || (!temporary && key !== manifest.hash)) fail('Skill 快照摘要不匹配');
    return { manifest, files: normalized.files };
  }
  async publish(user: string, input: SkillPackageFile[], source: EvaluatorSkillSource): Promise<EvaluatorSkillBinding> {
    const { name, files } = normalizeSkillPackage(input);
    const manifest = this.manifest(name, files);
    await this.write(this.directory(user, manifest.hash), manifest, files);
    await this.load(user, manifest.hash);
    return { name, source, snapshotHash: manifest.hash, fileCount: files.length, totalBytes: files.reduce((n, f) => n + f.data.length, 0) };
  }
  async publishImport(user: string, token: string) {
    const { manifest, files } = await this.load(user, token, true);
    return this.publish(user, files, { kind: 'local', originalFileName: manifest.originalFileName });
  }
  async preview(user: string, key: string, relative?: string | null, temporary = false) {
    const { manifest, files } = await this.load(user, key, temporary);
    return { name: manifest.name, ...previewSkillFiles(files, relative) };
  }
  private async cleanExpired(user: string) {
    const root = path.join(this.root, 'evaluator-skill-imports', this.userKey(user));
    for (const key of (await fs.readdir(root).catch(() => []))) {
      if (!/^[a-f0-9]{64}$/.test(key)) continue;
      const directory = this.directory(user, key, true);
      const manifest = await fs.readFile(path.join(directory, 'manifest.json'), 'utf8').then(s => JSON.parse(s) as Manifest).catch(() => null);
      if (manifest?.expiresAt && manifest.expiresAt <= this.now()) await fs.rm(directory, { recursive: true, force: true });
    }
  }
}
