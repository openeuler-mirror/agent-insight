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

export function formatExperimentTimestamp(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function defaultExperimentName(now = new Date()): string {
  return `Agent 评测 ${formatExperimentTimestamp(now)}`;
}

export function defaultSkillExperimentName(
  skillName: string,
  preset: 'trigger' | 'use-case' | 'skill-ab',
  version: number,
  now = new Date(),
): string {
  const label = preset === 'trigger' ? '触发分析' : preset === 'skill-ab' ? 'A/B 测试' : '用例分析';
  return `${skillName} · ${label} · v${version} · ${formatExperimentTimestamp(now)}`;
}

export function displayedExperimentName(name: string, createdAt: string | Date): string {
  if (!/^Agent 评测 \d{4}-\d{2}-\d{2} \d{2}:\d{2}(?: · (?:同配置|复用评测配置))+$/.test(name)) return name;
  const created = new Date(createdAt);
  return Number.isNaN(created.getTime()) ? name : defaultExperimentName(created);
}
