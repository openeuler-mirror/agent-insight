import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { EvaluatorCard } from '@/lib/evaluators/custom-evaluator-model';
import type { EvaluatorSkillBinding } from '@/lib/evaluators/evaluator-skills';
import { EvaluatorSkillStore, SKILL_INSTRUCTION_LIMIT } from '@/lib/evaluators/evaluator-skill-store';
import { savedSkillBindings } from '@/lib/evaluators/evaluator-skill-service';
import { buildJudgePrompt, parseJudgeText, type JudgeCaseContext } from '@/lib/evaluators/judge-assembly';
import type { EvaluatorOutput } from '@/lib/evaluators/eval-output';
import { opencodeJudgeCaller, type JudgeLlmCaller } from '@/lib/engine/experiment/judge-llm';
import { experimentSignal } from '@/lib/engine/experiment/cancellation-context';

export interface CustomEvaluatorRuntime {
  configHash: string;
  model: string;
  transport: 'opencode';
  skills: EvaluatorSkillBinding[];
  tools: Array<{ callId: string; name: string; status: string; input: string; output: string; truncated: boolean }>;
  durationMs: number;
  evaluationTraceId?: string;
  error?: string;
  toolsTruncated?: boolean;
}
export class CustomEvaluatorExecutionError extends Error {
  constructor(message: string, public runtime: CustomEvaluatorRuntime) { super(message); this.name = 'CustomEvaluatorExecutionError'; }
}

let callerForTest: JudgeLlmCaller | null = null;
export function setCustomEvaluatorSkillCallerForTest(caller: JudgeLlmCaller | null) { callerForTest = caller; }

function toolSummary(value: unknown): string {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, (key, val) => /api.?key|authorization|password|secret|access.?token/i.test(key) ? '[REDACTED]' : val);
  return text.replace(/((?:api[_-]?key|authorization|password|secret|access[_-]?token)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

export async function runCustomEvaluatorWithSkills(user: string, card: EvaluatorCard, ctx: JudgeCaseContext, options: {
  store?: EvaluatorSkillStore; caller?: JudgeLlmCaller; signal?: AbortSignal; timeoutMs?: number;
} = {}): Promise<{ output: EvaluatorOutput; raw: string; runtime: CustomEvaluatorRuntime }> {
  const started = Date.now();
  const bindings = savedSkillBindings(card.llmConfig?.skills);
  if (!bindings.length) throw new Error('Skill 评估必须包含已保存的 Skill');
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 180_000), ...[options.signal, experimentSignal()].filter((s): s is AbortSignal => Boolean(s))]);
  signal.throwIfAborted();
  const runtime: CustomEvaluatorRuntime = {
    configHash: createHash('sha256').update(JSON.stringify(card)).digest('hex'), model: '', transport: 'opencode', skills: [], tools: [], durationMs: 0,
  };
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'evaluator-skills-'));
  try {
    await fs.mkdir(path.join(workspace, '.git'));
    await fs.mkdir(path.join(workspace, 'inputs'));
    await fs.mkdir(path.join(workspace, 'outputs'));
    await fs.writeFile(path.join(workspace, 'inputs/case.json'), JSON.stringify(ctx), { mode: 0o600 });
    const store = options.store || new EvaluatorSkillStore();
    const instructions: string[] = [];
    let instructionBytes = 0;
    const names = new Set<string>();
    for (const binding of bindings) {
      signal.throwIfAborted();
      if (names.has(binding.name)) throw new Error('Skill 名称重复');
      names.add(binding.name);
      const snapshot = await store.load(user, binding.snapshotHash);
      if (snapshot.manifest.name !== binding.name) throw new Error('Skill 快照名称不匹配');
      const directory = path.join(workspace, '.opencode/skills', binding.name);
      for (const file of snapshot.files) {
        const target = path.join(directory, file.path);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, file.data, { mode: file.executable ? 0o700 : 0o600 });
      }
      const main = snapshot.files.find(f => f.path === 'SKILL.md')!.data;
      instructionBytes += main.length;
      if (instructionBytes > SKILL_INSTRUCTION_LIMIT || bindings.length > 8) throw new Error('Skill 主指令或数量超限');
      instructions.push(`【评估 Skill：${binding.name}】\n根目录：${directory}\n${main.toString('utf8')}`);
    }
    const prompt = buildJudgePrompt(card, ctx);
    signal.throwIfAborted();
    runtime.skills = bindings;
    const raw = await (options.caller || callerForTest || opencodeJudgeCaller)(user, {
      system: `${prompt.system}\n\n${instructions.join('\n\n')}\n\nPrompt 定义本次评判目标与标准，Skills 提供验证方法；所有 Skill 主指令均已加载。脚本与参考资料按适用条件使用。Skill 默认输出不能覆盖用户消息中的平台输出协议。无法消解的指令冲突或验证基础设施故障必须明确报错，不得编造分数。`,
      user: `${prompt.user}\n\n本次 Case 输入文件：${path.join(workspace, 'inputs/case.json')}。脚本产物写入 outputs/。`,
      directory: workspace, signal, timeoutMs: options.timeoutMs ?? 180_000, sessionTitle: `custom-eval-${card.name}`,
      recordTrace: { agentName: card.name, query: ctx.input || `评估器 ${card.name}` },
      onTraceSaved: taskId => { runtime.evaluationTraceId = taskId; },
      onModel: model => { runtime.model = model; },
      onTool: event => {
        const key = event.callID || event.partID;
        if (!key) return;
        const input = toolSummary(event.input), output = toolSummary(event.error || event.output);
        const tool = { callId: key, name: event.name, status: event.status || event.phase, input: input.slice(0, 1000), output: output.slice(0, 2000), truncated: input.length > 1000 || output.length > 2000 };
        const index = runtime.tools.findIndex(t => t.callId === key);
        if (index >= 0) runtime.tools[index] = tool;
        else if (runtime.tools.length < 64) runtime.tools.push(tool);
        else runtime.toolsTruncated = true;
      },
    });
    signal.throwIfAborted();
    const output = parseJudgeText(raw, card.pointsDef);
    if (!output.summary || !output.verdict || typeof output.score !== 'number') throw new Error('评估器未返回有效 verdict、summary 和 score');
    runtime.durationMs = Date.now() - started;
    return { raw, runtime, output: { ...output, evidence: { json: { type: 'custom-evaluator-runtime-v1', evaluationEvidence: output.evidence || null, customEvaluatorRuntime: runtime } } } };
  } catch (error) {
    runtime.durationMs = Date.now() - started;
    runtime.error = error instanceof Error ? error.message : String(error);
    throw new CustomEvaluatorExecutionError(runtime.error, runtime);
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
}
