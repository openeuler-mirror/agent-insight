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

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ChatHandlers, ToolCallEvent } from '@/lib/engine/skill-generation/opencode-agent-cli/opencode-client';
import type { DiagnosisProgressModule, DiagnosisProgressWriter } from './progress-types';

const MODULES = ['memory', 'reflection', 'planning', 'action', 'system'] as const;
const LABELS = { memory: '记忆', reflection: '反思', planning: '计划', action: '行动', system: '系统' };
type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const array = (value: unknown): RecordValue[] => Array.isArray(value) ? value.map(object) : [];
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);

export function createDiagnosisObserver(args: {
  workspaceDir: string;
  progress: DiagnosisProgressWriter;
  traceRefs: Array<{ traceStepIndex: number; anchorId?: string }>;
}) {
  const { progress, workspaceDir } = args;
  const refs = new Map(args.traceRefs.map(ref => [ref.traceStepIndex, ref]));
  const hashes = new Map<string, string>();
  const seenUpdates = new Set<string>();
  const directory = path.join(workspaceDir, '.agent-insight');
  const safe = (fn: () => void) => { try { fn(); } catch { progress.unavailable(); } };
  safe(() => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'agent-debug-progress-context.json'), JSON.stringify({ runId: progress.runId }), { mode: 0o600 });
  });
  function referenceList(items: RecordValue[]) {
    return [...new Set(items.map(item => Number(item.traceStepIndex)))].flatMap(step => refs.has(step) ? [refs.get(step)!] : []).slice(0, 12);
  }
  function scanArtifacts() {
    for (const [file, stage] of [['agent-debug-static.json', 'static'], ['agent-debug-core.json', 'core']] as const) {
      const fullPath = path.join(directory, file);
      if (!fs.existsSync(fullPath)) continue;
      if (fs.statSync(fullPath).size > 8 * 1024 * 1024) { progress.unavailable(); continue; }
      const raw = fs.readFileSync(fullPath, 'utf8');
      if (hashes.get(file) === hash(raw)) continue;
      let data: RecordValue;
      try { data = object(JSON.parse(raw)); } catch { continue; }
      if (!Array.isArray(data.stepRecords) && !Array.isArray(data.issues) && !Array.isArray(data.phase1Grid)) continue;
      hashes.set(file, hash(raw));
      progress.emit({ key: `${stage}:${hash(raw)}`, kind: 'stage', state: 'completed', title: stage === 'static' ? '静态检查结果已返回' : '主诊断阶段报告已生成', summary: '相关模块内容已更新，最终结论仍需等待报告校验。' });
      for (const dimension of MODULES) {
        const records = array(data.stepRecords).filter(record => String(object(object(record.modules)[dimension]).content || '').trim());
        const cells = array(data.phase1Grid).filter(cell => cell.module === dimension);
        const issues = array(data.issues).filter(issue => issue.module === dimension);
        if (!records.length && !cells.length && !issues.length) continue;
        const evidence = [...issues, ...cells];
        const summary = evidence.slice(0, 3).map(item => String(item.evidence || item.reasoning || '')).filter(Boolean).join('\n')
          || `已整理 ${records.length} 条相关执行记录；当前未获得独立问题结论。`;
        const content = JSON.stringify({ records, cells, issues });
        const reviewed = stage === 'core' && (issues.length > 0 || cells.some(cell => cell.errorDetected === true || cell.errorType === 'no_error' || String(cell.reasoning || '').trim()));
        progress.emit({ key: `${stage}:${dimension}:${hash(content)}`, kind: reviewed ? 'analysis' : 'evidence', module: dimension, state: reviewed ? 'completed' : 'update',
          title: `${LABELS[dimension]} · ${stage === 'static' ? '静态证据已获取' : reviewed ? '本轮检查结果已写入' : '阶段证据已返回'}`,
          summary, refs: referenceList([...evidence, ...records]) });
      }
    }
  }
  function scanUpdates() {
    const file = path.join(directory, 'agent-debug-progress.jsonl');
    if (!fs.existsSync(file)) return;
    if (fs.statSync(file).size > 256 * 1024) { progress.unavailable(); return; }
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n').slice(0, -1)) {
      if (seenUpdates.has(hash(line))) continue;
      let item: RecordValue;
      try { item = object(JSON.parse(line)); } catch { continue; }
      if (item.runId !== progress.runId || (item.module !== 'overall' && !MODULES.includes(item.module as typeof MODULES[number]))) continue;
      if (!['started', 'update', 'completed', 'skipped'].includes(String(item.state))) continue;
      if (typeof item.title !== 'string' || typeof item.summary !== 'string' || !item.summary.trim()) continue;
      seenUpdates.add(hash(line));
      progress.emit({ key: `summary:${hash(line)}`, kind: item.module === 'overall' ? 'stage' : 'analysis', module: item.module === 'overall' ? undefined : item.module as DiagnosisProgressModule,
        state: item.state as 'started' | 'update' | 'completed' | 'skipped', title: item.title, summary: item.summary,
        refs: Array.isArray(item.steps) ? [...new Set(item.steps)].flatMap(step => refs.has(Number(step)) ? [refs.get(Number(step))!] : []).slice(0, 12) : [] });
    }
  }
  const scan = () => safe(() => { scanArtifacts(); scanUpdates(); });
  function tool(event: ToolCallEvent) {
    if (event.phase === 'delta') return;
    const input = object(event.input);
    const command = String(input.command || input.filePath || input.path || '');
    if (command.includes('agentdebug_progress.py')) { if (event.phase === 'end') scan(); return; }
    const title = command.includes('agentdebug_static.py') ? '执行静态检查'
      : command.includes('agentdebug_inspect.py') ? '查询执行证据'
        : command.includes('detector_runner.py') ? '执行专项检查'
          : command.includes('agentdebug_validate.py') ? '校验诊断报告'
            : ['read', 'glob', 'grep'].includes(event.name) ? '读取诊断资料'
              : ['write', 'edit'].includes(event.name) ? '记录诊断分析' : '执行诊断工具';
    progress.emit({ key: `tool:${event.sessionID}:${event.callID || event.partID || hash(JSON.stringify([event.messageID, event.name, command]))}:${event.phase}`,
      kind: 'tool', state: event.phase === 'start' ? 'started' : event.phase === 'error' ? 'failed' : 'completed', title,
      summary: event.phase === 'start' ? '工具调用已开始，等待返回。' : event.phase === 'error' ? '本次工具调用失败，诊断任务可能继续处理。' : '工具调用已返回，正在收集可用的分析内容。' });
    if (event.phase === 'end') scan();
  }
  const handlers: ChatHandlers = {
    onTool: event => safe(() => tool(event)),
    onFileEdited: scan,
    onStep: event => { if (event.phase === 'finish') scan(); },
  };
  return { handlers, scan };
}
