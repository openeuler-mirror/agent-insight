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
import { db } from '@/lib/storage/prisma';
import { readUserCustomEvaluators } from '@/server/user_evaluators_storage';
import { resolveVersionStorageRoot } from '@/lib/engine/skill-opt/version-snapshot';
import type { EvaluatorCard } from './custom-evaluator-model';
import type { EvaluatorSkillBinding, EvaluatorSkillSelection } from './evaluator-skills';
import { EvaluatorSkillError, EvaluatorSkillStore, normalizeSkillPackage, SKILL_FILE_LIMIT, SKILL_INSTRUCTION_LIMIT, SKILL_PACKAGE_LIMIT, type SkillPackageFile } from './evaluator-skill-store';

export async function findEvaluatorSkillSource(user: string, name: string, owner: string | null) {
  const skills = await db.findSkills({ name, user: owner });
  const skill = skills.find(s => s.name === name && (s.user ?? null) === owner);
  if (!skill) throw new EvaluatorSkillError('Skill 来源不存在', 404);
  if (skill.user && skill.user !== user && skill.visibility !== 'public') throw new EvaluatorSkillError('无权访问该 Skill', 403);
  return skill;
}

export async function readLibrarySkill(user: string, name: string, owner: string | null, version: number) {
  if (!Number.isInteger(version) || version < 0) throw new EvaluatorSkillError('请选择具体 Skill 版本');
  const skill = await findEvaluatorSkillSource(user, name, owner);
  const row = await db.findSkillVersion(skill.id, version);
  if (!row) throw new EvaluatorSkillError('Skill 版本不存在', 404);
  const root = resolveVersionStorageRoot(skill.id, version, row.assetPath ?? null);
  const files: SkillPackageFile[] = [{ path: 'SKILL.md', data: Buffer.from(row.content || '') }];
  let bytes = files[0].data.length;
  const visit = async (directory: string, prefix = '') => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' && !prefix) return [];
      throw error;
    });
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relative === 'SKILL.md') continue;
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new EvaluatorSkillError('Skill 不支持链接或特殊文件');
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { await visit(absolute, relative); continue; }
      const stat = await fs.lstat(absolute);
      if (stat.size > SKILL_PACKAGE_LIMIT - bytes || files.length >= SKILL_FILE_LIMIT) throw new EvaluatorSkillError('Skill 文件数量或大小超限');
      bytes += stat.size;
      files.push({ path: relative, data: await fs.readFile(absolute), executable: Boolean(stat.mode & 0o111) });
    }
  };
  await visit(root);
  if (row.files) {
    let manifest: unknown;
    try { manifest = JSON.parse(row.files); } catch { throw new EvaluatorSkillError('Skill 文件清单无效'); }
    if (!Array.isArray(manifest) || manifest.some(p => typeof p !== 'string' || !files.some(f => f.path === p))) throw new EvaluatorSkillError('Skill 文件清单中的文件缺失');
  }
  const normalized = normalizeSkillPackage(files);
  if (normalized.name !== name) throw new EvaluatorSkillError('Skill 主文件 name 与库名称不一致，请先修正源 Skill');
  return normalized.files;
}

export async function normalizeEvaluatorSkillCards(user: string, incoming: EvaluatorCard[], previous: EvaluatorCard[], store = new EvaluatorSkillStore()) {
  const ids = new Set<string>();
  const result: EvaluatorCard[] = [];
  for (const card of incoming) {
    if (!card || typeof card !== 'object' || typeof card.id !== 'string' || ids.has(card.id)) throw new EvaluatorSkillError('评估器 id 无效或重复');
    ids.add(card.id);
    const old = previous.find(c => c.id === card.id);
    const raw = card.llmConfig?.skills === undefined ? old?.llmConfig?.skills ?? [] : card.llmConfig.skills;
    if (!Array.isArray(raw) || raw.length > 8) throw new EvaluatorSkillError('每个评估器最多添加 8 个 Skill');
    if (raw.length && card.evaluatorType !== 'LLM') throw new EvaluatorSkillError('只有自建 LLM 评估器支持 Skills');
    const bindings: EvaluatorSkillBinding[] = [];
    let instructions = 0;
    for (const value of raw) {
      if (!value || typeof value !== 'object') throw new EvaluatorSkillError('Skill 绑定无效');
      let binding: EvaluatorSkillBinding;
      if ('snapshotHash' in value) {
        const found = old?.llmConfig?.skills?.find(s => 'snapshotHash' in s && s.snapshotHash === value.snapshotHash && s.name === value.name
          && s.source.kind === value.source?.kind && (s.source.kind === 'library' && value.source.kind === 'library'
            ? s.source.owner === value.source.owner && s.source.version === value.source.version
            : s.source.kind === 'local' && value.source.kind === 'local' && s.source.originalFileName === value.source.originalFileName));
        if (!found || !('snapshotHash' in found)) throw new EvaluatorSkillError('不能引用未绑定的 Skill 快照');
        binding = found;
      } else if (value.kind === 'local') {
        binding = await store.publishImport(user, value.importToken);
      } else if (value.kind === 'library' && (value.sourceOwner === null || typeof value.sourceOwner === 'string')) {
        const files = await readLibrarySkill(user, value.name, value.sourceOwner, value.version);
        binding = await store.publish(user, files, { kind: 'library', owner: value.sourceOwner, version: value.version });
      } else { throw new EvaluatorSkillError('Skill 来源无效'); }
      const snapshot = await store.load(user, binding.snapshotHash);
      instructions += snapshot.files.find(f => f.path === 'SKILL.md')!.data.length;
      if (instructions > SKILL_INSTRUCTION_LIMIT) throw new EvaluatorSkillError('全部 Skill 主指令合计不能超过 64 KiB');
      if (bindings.some(b => b.name === binding.name)) throw new EvaluatorSkillError(`Skill 名称重复：${binding.name}`);
      bindings.push(binding);
    }
    result.push(card.llmConfig ? { ...card, llmConfig: { ...card.llmConfig, skills: bindings } } : card);
  }
  return result;
}

export function savedSkillBindings(skills: EvaluatorSkillSelection[] = []): EvaluatorSkillBinding[] {
  if (!Array.isArray(skills) || skills.length > 8 || skills.some(s => !s || !('snapshotHash' in s)
    || !/^[a-f0-9]{64}$/.test(s.snapshotHash) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.name)
    || !s.source || !['library', 'local'].includes(s.source.kind)
    || (s.source.kind === 'library' && (!Number.isInteger(s.source.version) || s.source.version < 0)))) {
    throw new EvaluatorSkillError('Skill 尚未保存为有效固定快照');
  }
  return skills as EvaluatorSkillBinding[];
}

export interface CustomSnapshots { schemaVersion: 1; cards: Record<string, EvaluatorCard> }
export async function freezeCustomEvaluators(user: string, ids: string[]): Promise<CustomSnapshots> {
  const customIds = ids.filter(id => id.startsWith('custom-'));
  const cards: Record<string, EvaluatorCard> = Object.create(null);
  if (customIds.length) {
    const current = await readUserCustomEvaluators(user) as EvaluatorCard[];
    const store = new EvaluatorSkillStore();
    for (const id of customIds) {
      const card = current.find(c => c.id === id);
      if (!card) throw new EvaluatorSkillError(`评估器 ${id} 不存在`);
      for (const skill of savedSkillBindings(card.llmConfig?.skills)) await store.load(user, skill.snapshotHash);
      cards[id] = JSON.parse(JSON.stringify(card));
    }
  }
  return { schemaVersion: 1, cards };
}

export async function withFrozenCustomEvaluators(user: string, ids: string[], snapshot: Record<string, unknown> = {}) {
  return { ...snapshot, customEvaluatorSnapshots: await freezeCustomEvaluators(user, ids) };
}

export async function resolveFrozenCustomEvaluator(user: string, id: string, snapshot: Record<string, unknown>): Promise<EvaluatorCard | null> {
  if (Object.hasOwn(snapshot, 'customEvaluatorSnapshots')) {
    const frozen = snapshot.customEvaluatorSnapshots as CustomSnapshots;
    if (frozen?.schemaVersion !== 1 || !frozen.cards || !Object.hasOwn(frozen.cards, id)) throw new EvaluatorSkillError('自建评估器冻结配置缺失或损坏');
    const card = frozen.cards[id];
    if (card?.id !== id || !card.llmConfig || card.evaluatorType !== 'LLM') throw new EvaluatorSkillError('自建评估器冻结配置无效');
    savedSkillBindings(card.llmConfig.skills);
    return card;
  }
  const card = (await readUserCustomEvaluators(user) as EvaluatorCard[]).find(c => c.id === id);
  return card ? { ...card, llmConfig: card.llmConfig ? { ...card.llmConfig, skills: [] } : undefined } : null;
}

export async function customEvaluatorsForReuse(user: string, ids: string[], snapshot: Record<string, unknown>): Promise<CustomSnapshots> {
  const cards: Record<string, EvaluatorCard> = Object.create(null);
  for (const id of ids.filter(id => id.startsWith('custom-'))) {
    const card = await resolveFrozenCustomEvaluator(user, id, snapshot);
    if (!card) throw new EvaluatorSkillError(`评估器 ${id} 已不存在且没有历史快照`);
    cards[id] = card;
  }
  return { schemaVersion: 1, cards };
}
