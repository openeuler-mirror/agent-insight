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

import { createHash } from 'crypto';

import { prismaRaw } from '@/lib/storage/prisma';
import {isStorageCoreEnabled} from '@/lib/storage-core/mode';
import {requireCoreExperimentContext} from '@/lib/storage-core/experiments';

const GENERATOR = 'experiment-skill-issues@1.0';

type IssueSource = 'dynamic' | 'trigger';
type Severity = 'high' | 'medium' | 'low';

interface ExperimentPoint {
  label?: unknown;
  status?: unknown;
  score?: unknown;
  severity?: unknown;
  skillAttributable?: unknown;
  isSkillAttributable?: unknown;
  is_skill_attributable?: unknown;
  suggestion?: unknown;
  improvementSuggestion?: unknown;
  improvement_suggestion?: unknown;
  evidence?: unknown;
}

interface NormalizedExperimentIssue {
  severity: Severity;
  category: string;
  summary: string;
  evidence: string | null;
  reasoning: string | null;
  suggestedFix: string;
  dedupKey: string;
  evaluatorId: string;
  resultId: string;
  executionId: string | null;
}

function parseArray(value: string | null): ExperimentPoint[] {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [];
  } catch {
    return [];
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sourceForExperiment(preset: string | null, scope: string): IssueSource | null {
  if (preset === 'trigger') return 'trigger';
  if (preset === 'use-case' || scope === 'skill-case-analysis') return 'dynamic';
  return null;
}

function evidenceText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const markdown = text(record.md);
  if (markdown) return markdown;
  try {
    return JSON.stringify(record);
  } catch {
    return null;
  }
}

function normalizeSeverity(point: ExperimentPoint): Severity {
  const explicit = text(point.severity).toLowerCase();
  if (explicit === 'high' || explicit === 'medium' || explicit === 'low') return explicit;
  const status = text(point.status).toLowerCase();
  if (status === 'missing' || status === 'fail' || status === 'failed') return 'high';
  if (status === 'partial' || status === 'warn' || status === 'warning') return 'medium';
  const score = Number(point.score);
  if (Number.isFinite(score)) {
    if (score < 50) return 'high';
    if (score < 100) return 'medium';
  }
  return 'low';
}

function categoryFor(source: IssueSource, evaluatorId: string): string {
  if (source === 'trigger') return '触发评测';
  if (evaluatorId.includes('task-completion')) return '任务完成度';
  if (evaluatorId.includes('trace-quality')) return '轨迹偏差';
  if (evaluatorId.includes('result')) return '结果问题';
  return '用例评测';
}

function normalizeDedupPart(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function dedupKeyFor(source: IssueSource, category: string, summary: string, suggestedFix: string): string {
  return createHash('sha1')
    .update([
      source,
      normalizeDedupPart(category),
      normalizeDedupPart(summary),
      normalizeDedupPart(suggestedFix),
    ].join('::'))
    .digest('hex')
    .slice(0, 12);
}

function isSkillAttributable(point: ExperimentPoint): boolean {
  return point.skillAttributable === true
    || point.isSkillAttributable === true
    || point.is_skill_attributable === true;
}

function suggestionText(point: ExperimentPoint): string {
  return text(point.suggestion)
    || text(point.improvementSuggestion)
    || text(point.improvement_suggestion);
}

export async function syncExperimentSkillIssues(experimentId: string): Promise<{
  source: IssueSource | null;
  written: number;
  cleared: number;
}> {
  {requireCoreExperimentContext();return {source:null,written:0,cleared:0};}
}

export async function syncCompletedSkillExperimentIssues(input: {
  user: string;
  skillName: string;
  skillVersion: number;
}): Promise<{ experiments: number; written: number }> {
  {if(requireCoreExperimentContext().actor.username!==input.user)throw Object.assign(new Error('Issue sync actor differs'),{status:403});return {experiments:0,written:0};}
}
