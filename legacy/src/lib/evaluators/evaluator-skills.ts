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

export type EvaluatorSkillSource =
  | { kind: 'library'; owner: string | null; version: number }
  | { kind: 'local'; originalFileName?: string };

export interface EvaluatorSkillBinding {
  name: string;
  source: EvaluatorSkillSource;
  snapshotHash: string;
  fileCount: number;
  totalBytes: number;
}

export type EvaluatorSkillSelection = EvaluatorSkillBinding
  | { kind: 'library'; name: string; sourceOwner: string | null; version: number }
  | { kind: 'local'; name: string; importToken: string; fileCount: number };

export interface EvaluatorSkillFileInfo { path: string; size: number; executable: boolean }

export function evaluatorSkillSourceLabel(skill: EvaluatorSkillBinding): string {
  return skill.source.kind === 'library' ? `Skill 库 · v${skill.source.version}` : `本地导入 · ${skill.snapshotHash.slice(0, 8)}`;
}

export function agentEvaluationTraceId(evidence: unknown): string | null {
  if (!evidence || typeof evidence !== 'object') return null;
  const envelope = (evidence as { json?: unknown }).json;
  if (!envelope || typeof envelope !== 'object') return null;
  const value = envelope as { type?: string; customEvaluatorRuntime?: { transport?: string; evaluationTraceId?: unknown; skills?: unknown[] } };
  const runtime = value.customEvaluatorRuntime;
  return value.type === 'custom-evaluator-runtime-v1' && runtime?.transport === 'opencode'
    && Array.isArray(runtime.skills) && runtime.skills.length > 0
    && typeof runtime.evaluationTraceId === 'string' && /^[a-zA-Z0-9_-]+$/.test(runtime.evaluationTraceId)
    ? runtime.evaluationTraceId : null;
}
