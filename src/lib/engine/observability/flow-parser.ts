import { OpenAI } from "openai";
import { getProxyConfig } from '@/lib/ingest/proxy-config';
import { getActiveConfig } from '@/lib/storage/server-config';
import { db } from '@/lib/storage/prisma';
import { generateFlowParsePrompt, generateExecutionMatchPrompt, generateStepExtractPrompt, generateDynamicOnlyMatchPrompt } from '@/prompts/flow-parse-prompt';
import { buildAgentCallTree, walkTree, type AgentEvent, type AgentNode, type RawInteraction } from '@/lib/engine/observability/agent-trace';
import fs from 'fs';
import path from 'path';

const LOG_FILE = path.join(process.cwd(), 'data', 'flow_debug.jsonl');
const BATCH_SIZE = 10;

interface LogInput {
  skillId?: string;
  version?: number;
  executionId?: string;
}

interface LogOutput {
  raw_output?: string;
}

function appendLog(stage: string, input: LogInput, output: LogOutput): void {
  try {
    const logDir = path.dirname(LOG_FILE);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    
    const record = {
      timestamp: new Date().toISOString(),
      stage,
      input,
      output
    };
    fs.appendFileSync(LOG_FILE, JSON.stringify(record) + '\n');
  } catch (e) { 
    console.error('Log error', e); 
  }
}

async function getLlmClient(user?: string | null) {
  const config = await getActiveConfig(user);
  if (!config) {
    return { client: null, model: null };
  }

  const apiKey = config.apiKey;
  if (!apiKey) return { client: null, model: null };

  const baseURL = config.baseUrl || "https://api.deepseek.com";
  const { customFetch } = getProxyConfig();
  
  return {
    client: new OpenAI({
      apiKey, 
      baseURL,
      fetch: customFetch,
    }),
    model: config.model || "deepseek-chat"
  };
}

export type ControlFlowType = 'required' | 'conditional' | 'loop' | 'optional' | 'handoff';

export interface FlowStep {
  id: string;
  name: string;
  description: string;
  type: 'action' | 'decision' | 'output';
  isOptional?: boolean;
  controlFlowType?: ControlFlowType;
}

export interface FlowBranch {
  condition: string;
  trueStepId: string;
  falseStepId: string;
}

export interface ConditionalGroupBranch {
  label: string;
  stepIds: string[];
}

export interface ConditionalGroup {
  id: string;
  condition: string;
  branches: ConditionalGroupBranch[];
}

export interface LoopGroup {
  id: string;
  loopCondition: string;
  bodyStepIds: string[];
  expectedMinCount: number;
  expectedMaxCount: number;
}

export interface ParsedFlowResult {
  steps: FlowStep[];
  branches?: FlowBranch[];
  conditionalGroups?: ConditionalGroup[];
  loopGroups?: LoopGroup[];
  summary?: string;
}

export interface ExtractedKeyAction {
  id: string;
  content: string;
  weight: number;
  controlFlowType: ControlFlowType;
  condition?: string;
  branchLabel?: string;
  loopCondition?: string;
  expectedMinCount?: number;
  expectedMaxCount?: number;
  skillSource?: string;
  groupId?: string;
}

export interface StepMatch {
  evaluationStepId?: string;
  expectedStepId?: string;
  expectedStepName?: string;
  actualStepIndex?: number;
  actualAction?: string;
  matchStatus: 'matched' | 'partial' | 'unexpected' | 'delegated' | 'non_business' | 'skipped';
  matchReason: string;
}

export interface MatchSummary {
  totalSteps: number;
  matchedSteps: number;
  partialSteps?: number;
  unexpectedSteps: number;
  delegatedSteps?: number;
  nonBusinessSteps?: number;
  skippedSteps: number;
  orderViolations: number;
  overallScore: number;
}

export interface ProblemStep {
  evaluationStepId?: string;
  stepIndex?: number;
  stepName: string;
  status: 'partial' | 'unexpected' | 'non_business' | 'skipped';
  problem: string;
  suggestion: string;
}

export interface SkippedExpectedStep {
  expectedStepId: string;
  expectedStepName: string;
}

export interface AlignmentActualStep {
  index: number;
  action: string;
  type: 'action' | 'decision' | 'output';
  description?: string;
  dialogStartIndex?: number;
  dialogEndIndex?: number;
}

export interface AlignmentExpectedStep {
  id: string;
  name: string;
  description?: string;
  type?: 'action' | 'decision' | 'output';
  order: number;
}

export interface AlignmentMapping {
  actualStepIndex: number;
  expectedStepId?: string;
  expectedStepName?: string;
  status: 'matched' | 'partial' | 'unexpected' | 'delegated' | 'non_business';
  reason?: string;
}

export interface AlignmentSkillSpan {
  skillName: string;
  version?: number;
  startActualStepIndex: number;
  endActualStepIndex: number;
  trigger: 'primary' | 'invoked' | 'load_skill' | 'trace_tag' | 'subagent';
  expectedStepId?: string;
  expectedStepName?: string;
  evaluationStatus?: 'matched' | 'partial' | 'unexpected' | 'non_business';
  evaluationReason?: string;
}

export interface AlignmentViolation {
  kind: 'partial' | 'unexpected' | 'non_business' | 'skipped' | 'order_violation' | 'tool_choice';
  actualStepIndex?: number;
  expectedStepId?: string;
  expectedStepName?: string;
  severity: 'high' | 'medium' | 'low';
  problem: string;
  suggestion?: string;
  evidenceInteractionIndexes?: number[];
}

export interface TraceSkillAlignment {
  actualSteps: AlignmentActualStep[];
  expectedSteps: AlignmentExpectedStep[];
  mappings: AlignmentMapping[];
  skippedExpectedSteps: SkippedExpectedStep[];
  skillSpans: AlignmentSkillSpan[];
  violations: AlignmentViolation[];
  summary: MatchSummary;
}

export interface ExecutionMatchResult {
  matches: StepMatch[];
  skippedExpectedSteps: SkippedExpectedStep[];
  summary: MatchSummary;
  problemSteps: ProblemStep[];
  alignment?: TraceSkillAlignment;
}

export async function parseSkillFlow(
  skillContent: string,
  skillId: string,
  version: number,
  user?: string | null
): Promise<{ success: boolean; flow?: ParsedFlowResult; mermaidCode?: string; error?: string }> {
  const { client, model } = await getLlmClient(user);
  
  if (!client || !client.apiKey) {
    return { success: false, error: "请在首页左上角的设置中配置 LLM" };
  }

  if (!skillContent || skillContent.trim().length === 0) {
    return { success: false, error: "Skill 内容为空" };
  }

  try {
    await db.upsertParsedFlow({
      skillId,
      version,
      user: user || null,
      // Use empty strings for the "parsing" placeholder so legacy SQLite
      // schemas with NOT NULL columns remain compatible.
      flowJson: '',
      mermaidCode: ''
    });

    const prompt = generateFlowParsePrompt(skillContent);
    
    const response = await client.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: model,
      temperature: 0.3
    });

    const content = response.choices?.[0]?.message?.content;
    
    if (!content) {
      return { success: false, error: "LLM 返回内容为空" };
    }

    appendLog('flow_parse', { skillId, version }, { raw_output: content });

    let jsonStr = content.trim();
    const match = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (match) {
      jsonStr = match[1];
    } else {
      const first = jsonStr.indexOf('{');
      const last = jsonStr.lastIndexOf('}');
      if (first !== -1 && last !== -1 && last >= first) {
        jsonStr = jsonStr.substring(first, last + 1);
      }
    }

    const flow: ParsedFlowResult = JSON.parse(jsonStr);
    
    if (!flow.steps || !Array.isArray(flow.steps) || flow.steps.length === 0) {
      return { success: false, error: "解析结果中未找到有效步骤" };
    }

    const validStepIds = new Set(flow.steps.map(s => s.id));

    if (flow.conditionalGroups && Array.isArray(flow.conditionalGroups)) {
      for (const cg of flow.conditionalGroups) {
        if (!cg.branches || !Array.isArray(cg.branches)) {
          console.warn(`[FlowParse] ConditionalGroup ${cg.id} has invalid branches, degrading to required`);
        }
      }
    } else {
      flow.conditionalGroups = [];
    }

    if (!flow.loopGroups || !Array.isArray(flow.loopGroups)) {
      flow.loopGroups = [];
    }

    const loopBodyStepIds = new Set<string>();
    for (const lg of flow.loopGroups) {
      if (!lg.bodyStepIds || !Array.isArray(lg.bodyStepIds)) {
        console.warn(`[FlowParse] LoopGroup ${lg.id} has invalid bodyStepIds, degrading to required`);
        continue;
      }
      for (const sid of lg.bodyStepIds) {
        if (!validStepIds.has(sid)) {
          console.warn(`[FlowParse] LoopGroup ${lg.id} references invalid stepId ${sid}, degrading to required`);
        } else {
          loopBodyStepIds.add(sid);
        }
      }
    }

    const conditionalStepIds = new Set<string>();
    if (flow.conditionalGroups) {
      for (const cg of flow.conditionalGroups) {
        if (!cg.branches) continue;
        for (const branch of cg.branches) {
          if (!branch.stepIds) continue;
          for (const sid of branch.stepIds) {
            if (!validStepIds.has(sid)) {
              console.warn(`[FlowParse] ConditionalGroup ${cg.id} references invalid stepId ${sid}, degrading to required`);
            } else {
              conditionalStepIds.add(sid);
            }
          }
        }
      }
    }

    for (const step of flow.steps) {
      if (step.controlFlowType) continue;

      if (loopBodyStepIds.has(step.id)) {
        step.controlFlowType = 'loop';
      } else if (conditionalStepIds.has(step.id)) {
        step.controlFlowType = 'conditional';
      } else if (step.isOptional) {
        step.controlFlowType = 'optional';
      } else {
        step.controlFlowType = 'required';
      }
    }

    const mermaidCode = generateMermaidCode(flow);

    await db.upsertParsedFlow({
      skillId,
      version,
      user: user || null,
      flowJson: JSON.stringify(flow),
      mermaidCode
    });

    return { success: true, flow, mermaidCode };
    
  } catch (error) {
    const message = error instanceof Error ? error.message : "解析失败";
    console.error("Flow parse error:", error);
    return { success: false, error: message };
  }
}

function sanitizeMermaidLabel(label: string): string {
  return label
    .replace(/\\/g, '\\\\')
    .replace(/"/g, "'")
    .replace(/\(/g, '（')
    .replace(/\)/g, '）')
    .replace(/\[/g, '［')
    .replace(/\]/g, '］')
    .replace(/\{/g, '｛')
    .replace(/\}/g, '｝')
    .replace(/</g, '＜')
    .replace(/>/g, '＞')
    .replace(/\|/g, '｜')
    .replace(/\n/g, ' ')
    .trim();
}

export function generateMermaidCode(flow: ParsedFlowResult): string {
  const lines: string[] = ['flowchart TD'];
  
  flow.steps.forEach((step, index) => {
    const nodeId = `S${index + 1}`;
    const cfType = step.controlFlowType || 'required';
    const prefix = cfType === 'loop' ? '🔄 ' : '';
    const label = sanitizeMermaidLabel(`${prefix}${index + 1}. ${step.name}`);
    const nodeType = step.type === 'decision' ? '{' + label + '}' : 
                     step.type === 'output' ? '((' + label + '))' :
                     '[' + label + ']';
    lines.push(`    ${nodeId}${nodeType}`);
  });

  const branchStepIds = new Set<string>();
  const branchStepsMap = new Map<string, string[]>();

  if (flow.conditionalGroups) {
    for (const cg of flow.conditionalGroups) {
      for (const branch of cg.branches) {
        if (branch.stepIds && branch.stepIds.length > 0) {
          branchStepsMap.set(branch.label, branch.stepIds);
          for (const stepId of branch.stepIds) {
            branchStepIds.add(stepId);
          }
        }
      }
    }
  }

  for (let i = 0; i < flow.steps.length - 1; i++) {
    const currentStep = flow.steps[i];
    const nextStep = flow.steps[i + 1];
    const currentNode = `S${i + 1}`;
    const nextNode = `S${i + 2}`;
    
    const branch = flow.branches?.find(b => 
      b.trueStepId === nextStep?.id || 
      b.falseStepId === nextStep?.id
    );
    
    if (branch && currentStep.type === 'decision') {
      lines.push(`    ${currentNode} -->|是| ${nextNode}`);
      const falseStepIndex = flow.steps.findIndex(s => s.id === branch.falseStepId);
      if (falseStepIndex !== -1 && falseStepIndex !== i + 1) {
        lines.push(`    ${currentNode} -->|否| S${falseStepIndex + 1}`);
      }
    } else {
      const currentIsBranch = branchStepIds.has(currentStep.id);
      const nextIsBranch = branchStepIds.has(nextStep.id);

      // 【新增拦截逻辑】：防止向分支起点画出多余的默认连线
      if (!currentIsBranch && nextIsBranch) {
        continue;
      }

      if (currentIsBranch && nextIsBranch) {
        let sameBranch = false;
        for (const [_, stepIds] of branchStepsMap) {
          const currentIndex = stepIds.indexOf(currentStep.id);
          const nextIndex = stepIds.indexOf(nextStep.id);
          if (currentIndex !== -1 && nextIndex !== -1 && nextIndex === currentIndex + 1) {
            sameBranch = true;
            break;
          }
        }
        if (!sameBranch) {
          continue;
        }
      }

      lines.push(`    ${currentNode} --> ${nextNode}`);
    }
  }

  if (flow.conditionalGroups) {
    for (const cg of flow.conditionalGroups) {
      let maxStepIndex = -1;
      let minStepIndex = flow.steps.length;

      // 1. 遍历计算当前条件组在整个数组中的边界索引
      for (const branch of cg.branches) {
        if (!branch.stepIds || branch.stepIds.length === 0) continue;
        
        const firstStepIndex = flow.steps.findIndex(s => s.id === branch.stepIds[0]);
        if (firstStepIndex !== -1 && firstStepIndex < minStepIndex) {
          minStepIndex = firstStepIndex;
        }

        branch.stepIds.forEach(id => {
          const idx = flow.steps.findIndex(s => s.id === id);
          if (idx > maxStepIndex) {
            maxStepIndex = idx;
          }
        });
      }

      // 确定属于该组的 Decision 节点
      let decisionIndex = -1;
      if (minStepIndex > 0 && flow.steps[minStepIndex - 1].type === 'decision') {
          decisionIndex = minStepIndex - 1;
      } else {
          // 降级回退：找最近的一个 decision 节点
          const dStep = flow.steps.find(s => s.type === 'decision');
          if (dStep) decisionIndex = flow.steps.indexOf(dStep);
      }

      // 2. 画线：Decision 节点 -> 各个分支起始节点
      if (decisionIndex !== -1) {
        for (const branch of cg.branches) {
           if (!branch.stepIds || branch.stepIds.length === 0) continue;
           const firstStepIndex = flow.steps.findIndex(s => s.id === branch.stepIds[0]);
           if (firstStepIndex !== -1) {
               lines.push(`    S${decisionIndex + 1} -->|${branch.label}| S${firstStepIndex + 1}`);
           }
        }
      }

      // 3. 将各个分支的最后一个节点，连向后续的公共节点进行汇合
      const commonStepIndex = maxStepIndex + 1;
      if (commonStepIndex > 0 && commonStepIndex < flow.steps.length) {
        const commonNode = `S${commonStepIndex + 1}`;
        for (const branch of cg.branches) {
          if (!branch.stepIds || branch.stepIds.length === 0) continue;
          
          const lastStepId = branch.stepIds[branch.stepIds.length - 1];
          const lastStepIndex = flow.steps.findIndex(s => s.id === lastStepId);
          
          // 排除数组里自然相连的最后一个分支，避免重复画线
          if (lastStepIndex !== -1 && lastStepIndex !== commonStepIndex - 1) {
            lines.push(`    S${lastStepIndex + 1} --> ${commonNode}`);
          }
        }
      }
    }
  }

  lines.push('');
  lines.push('    style S1 fill:#38bdf8,color:#0f172a');
  
  const lastStep = `S${flow.steps.length}`;
  if (flow.steps[flow.steps.length - 1]?.type === 'output') {
    lines.push(`    style ${lastStep} fill:#4ade80,color:#0f172a`);
  }

  flow.steps.forEach((step, index) => {
    const nodeId = `S${index + 1}`;
    const cfType = step.controlFlowType || 'required';
    if (cfType === 'optional') {
      lines.push(`    style ${nodeId} stroke-dasharray: 5 5`);
    } else if (cfType === 'loop') {
      lines.push(`    style ${nodeId} fill:#a78bfa,color:#0f172a`);
    } else if (cfType === 'conditional') {
      lines.push(`    style ${nodeId} fill:#fbbf24,color:#0f172a`);
    } else if (cfType === 'handoff') {
      lines.push(`    style ${nodeId} fill:#4ade80,color:#0f172a`);
    }
  });

  return lines.join('\n');
}

export function extractKeyActionsFromFlow(flow: ParsedFlowResult): ExtractedKeyAction[] {
  const actions: ExtractedKeyAction[] = [];
  const stepIdToGroup = new Map<string, { type: ControlFlowType; group: ConditionalGroup | LoopGroup }>();

  if (flow.conditionalGroups) {
    for (const cg of flow.conditionalGroups) {
      for (const branch of cg.branches) {
        for (const stepId of branch.stepIds) {
          stepIdToGroup.set(stepId, { type: 'conditional', group: cg });
        }
      }
    }
  }

  if (flow.loopGroups) {
    for (const lg of flow.loopGroups) {
      for (const stepId of lg.bodyStepIds) {
        stepIdToGroup.set(stepId, { type: 'loop', group: lg });
      }
    }
  }

  const validStepIds = new Set(flow.steps.map(s => s.id));

  if (flow.conditionalGroups) {
    for (const cg of flow.conditionalGroups) {
      for (const branch of cg.branches) {
        for (const stepId of branch.stepIds) {
          if (!validStepIds.has(stepId)) {
            console.warn(`[FlowParse] ConditionalGroup ${cg.id} references invalid stepId ${stepId}, degrading to required`);
            stepIdToGroup.delete(stepId);
          }
        }
      }
    }
  }

  if (flow.loopGroups) {
    for (const lg of flow.loopGroups) {
      for (const stepId of lg.bodyStepIds) {
        if (!validStepIds.has(stepId)) {
          console.warn(`[FlowParse] LoopGroup ${lg.id} references invalid stepId ${stepId}, degrading to required`);
          stepIdToGroup.delete(stepId);
        }
      }
    }
  }

  const branchCountMap = new Map<string, number>();
  if (flow.conditionalGroups) {
    for (const cg of flow.conditionalGroups) {
      branchCountMap.set(cg.id, cg.branches.length);
    }
  }

  for (const step of flow.steps) {
    const groupInfo = stepIdToGroup.get(step.id);

    if (step.isOptional && !groupInfo) {
      actions.push({
        id: step.id,
        content: step.name,
        weight: 0,
        controlFlowType: 'optional',
      });
      continue;
    }

    if (groupInfo?.type === 'conditional') {
      const cg = groupInfo.group as ConditionalGroup;
      const branch = cg.branches.find(b => b.stepIds.includes(step.id));
      const branchCount = branchCountMap.get(cg.id) || 1;
      actions.push({
        id: step.id,
        content: step.name,
        weight: 1.0 / branchCount,
        controlFlowType: 'conditional',
        condition: cg.condition,
        branchLabel: branch?.label,
        groupId: cg.id,
      });
      continue;
    }

    if (groupInfo?.type === 'loop') {
      const lg = groupInfo.group as LoopGroup;
      actions.push({
        id: step.id,
        content: step.name,
        weight: 1.0,
        controlFlowType: 'loop',
        loopCondition: lg.loopCondition,
        expectedMinCount: lg.expectedMinCount,
        expectedMaxCount: lg.expectedMaxCount,
        groupId: lg.id,
      });
      continue;
    }

    if (step.isOptional) {
      actions.push({
        id: step.id,
        content: step.name,
        weight: 0,
        controlFlowType: 'optional',
      });
      continue;
    }

    actions.push({
      id: step.id,
      content: step.name,
      weight: 1.0,
      controlFlowType: 'required',
    });
  }

  return actions;
}

export function mergeKeyActionsFromMultipleSkills(
  skills: { name: string; actions: ExtractedKeyAction[] }[]
): ExtractedKeyAction[] {
  const merged: ExtractedKeyAction[] = [];

  for (let i = 0; i < skills.length; i++) {
    const { name, actions } = skills[i];

    for (const action of actions) {
      merged.push({
        ...action,
        id: `${name}-${action.id}`,
        skillSource: name,
      });
    }

    if (i < skills.length - 1) {
      const nextName = skills[i + 1].name;
      merged.push({
        id: `handoff-${name}-to-${nextName}`,
        content: `从 ${name} 输出衔接至 ${nextName} 输入`,
        weight: 1.0,
        controlFlowType: 'handoff',
        skillSource: `${name}->${nextName}`,
      });
    }
  }

  return merged;
}

export function generateDynamicMermaidCode(
  flow: ParsedFlowResult,
  matches: StepMatch[],
  skippedExpectedSteps: SkippedExpectedStep[],
  extractedSteps: ExtractedStep[]
): string {
  const lines: string[] = ['flowchart LR'];
  
  const statusColor: Record<string, string> = {
    'matched': '#4ade80',
    'partial': '#fbbf24',
    'unexpected': '#f87171',
    'delegated': '#60a5fa',
    'non_business': '#a3a3a3',
    'skipped': '#94a3b8'
  };

  lines.push('    subgraph Skill流程');
  lines.push('        direction LR');
  
  flow.steps.forEach((step, index) => {
    const nodeId = `S${index + 1}`;
    const label = sanitizeMermaidLabel(`${index + 1}. ${step.name}`);
    const nodeType = step.type === 'decision' ? '{' + label + '}' : 
                     step.type === 'output' ? '((' + label + '))' :
                     '[' + label + ']';
    lines.push(`        ${nodeId}${nodeType}`);
  });
  
  for (let i = 0; i < flow.steps.length - 1; i++) {
    const currentNode = `S${i + 1}`;
    const nextNode = `S${i + 2}`;
    lines.push(`        ${currentNode} --> ${nextNode}`);
  }
  lines.push('    end');
  
  lines.push('');
  lines.push('    subgraph 实际执行轨迹');
  lines.push('        direction LR');
  
  const actualSteps: { id: string; label: string; status: string; targetStep?: string; dialogIndex: number; type: string }[] = [];
  
  const validMatches = matches.filter(m => m.matchStatus !== 'skipped');
  const sortedMatches = [...validMatches].sort((a, b) => (a.actualStepIndex ?? 0) - (b.actualStepIndex ?? 0));
  
  sortedMatches.forEach((match, idx) => {
    const nodeId = `A${idx + 1}`;
    const status = match.matchStatus;
    const dialogIndex = match.actualStepIndex ?? idx;
    const label = sanitizeMermaidLabel(`#${dialogIndex} ${match.actualAction || `实际步骤 ${dialogIndex}`}`);
    
    // 从 extractedSteps 获取步骤类型
    const extractedStep = extractedSteps.find(s => 
      uiStepIndexOf(s) === dialogIndex
      || (s.uiStepIndex == null && s.dialogStartIndex <= dialogIndex && s.dialogEndIndex >= dialogIndex)
    );
    const stepType = extractedStep?.type || 'action';
    
    actualSteps.push({
      id: nodeId,
      label,
      status,
      targetStep: match.expectedStepId,
      dialogIndex,
      type: stepType
    });
    
    // 根据类型生成不同形状的节点
    const nodeType = stepType === 'decision' ? '{' + label + '}' : 
                     stepType === 'output' ? '((' + label + '))' :
                     '[' + label + ']';
    lines.push(`        ${nodeId}${nodeType}`);
  });
  
  if (actualSteps.length > 1) {
    for (let i = 0; i < actualSteps.length - 1; i++) {
      lines.push(`        ${actualSteps[i].id} --> ${actualSteps[i + 1].id}`);
    }
  }
  lines.push('    end');
  
  lines.push('');
  actualSteps.forEach((step) => {
    if (step.status !== 'unexpected' && step.targetStep) {
      const targetIndex = flow.steps.findIndex(s => s.id === step.targetStep);
      if (targetIndex !== -1) {
        const targetNode = `S${targetIndex + 1}`;
        lines.push(`    ${targetNode} -.- ${step.id}`);
      }
    }
  });
  
  lines.push('');
  flow.steps.forEach((step, index) => {
    const nodeId = `S${index + 1}`;
    const isSkipped = skippedExpectedSteps.some(s => s.expectedStepId === step.id);
    const partialMatch = matches.find(m => m.expectedStepId === step.id && m.matchStatus === 'partial');
    
    let status: string;
    if (isSkipped) {
      status = 'skipped';
    } else if (partialMatch) {
      status = 'partial';
    } else {
      status = 'matched';
    }
    
    const color = statusColor[status];
    lines.push(`    style ${nodeId} fill:${color},color:#0f172a`);
  });
  
  actualSteps.forEach((step) => {
    const color = statusColor[step.status];
    lines.push(`    style ${step.id} fill:${color},color:#0f172a`);
  });

  return lines.join('\n');
}

interface InteractionMessage {
  role?: string;
  content?: string | InteractionContent[];
  agent?: string;
  subagent_name?: string;
  subagent_session_id?: string;
  // OTEL / upload 通道存进 session.interactions 的"归一化"结构
  // (judge.ts:normalizeInteractions / otel/v1/traces/route.ts 共享这套字段)
  requestMessages?: Array<{ role?: string; content?: unknown }>;
  responseMessage?: {
    role?: string;
    content?: unknown;
    tool_calls?: Array<{ name?: string; arguments?: unknown; function?: { name?: string; arguments?: unknown } }>;
  };
  toolCall?: { name?: string; arguments?: string };
  toolCalls?: Array<{ name?: string; arguments?: unknown; function?: { name?: string; arguments?: unknown } }>;
  tool_calls?: Array<{ name?: string; arguments?: unknown; function?: { name?: string; arguments?: unknown } }>;
}

interface InteractionContent {
  type: string;
  text?: string;
  name?: string;
}

function extractInteractionText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object') {
          const part = c as InteractionContent;
          if (part.type === 'text' && part.text) return part.text;
        }
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

function collectToolCallNames(interaction: InteractionMessage): string[] {
  const names: string[] = [];
  if (interaction.toolCall?.name) names.push(interaction.toolCall.name);
  if (Array.isArray(interaction.toolCalls)) {
    for (const tc of interaction.toolCalls) {
      const n = tc?.name || tc?.function?.name;
      if (n) names.push(n);
    }
  }
  if (Array.isArray(interaction.responseMessage?.tool_calls)) {
    for (const tc of interaction.responseMessage!.tool_calls!) {
      const n = tc?.function?.name || tc?.name;
      if (n) names.push(n);
    }
  }
  if (Array.isArray(interaction.content)) {
    for (const c of interaction.content) {
      if ((c.type === 'toolCall' || c.type === 'tool_use') && c.name) names.push(c.name);
    }
  }
  return names;
}

export async function analyzeExecutionMatch(
  executionId: string,
  skillId: string,
  skillVersion: number,
  user?: string | null,
  skillName?: string | null
): Promise<{ success: boolean; result?: ExecutionMatchResult; staticMermaid?: string; dynamicMermaid?: string; flow?: ParsedFlowResult; extractedSteps?: ExtractedStep[]; interactionCount?: number; error?: string }> {
  const { client, model } = await getLlmClient(user);
  
  if (!client || !client.apiKey) {
    return { success: false, error: "请在首页左上角的设置中配置 LLM" };
  }

  try {
    const parsedFlow = await db.findParsedFlow(skillId, skillVersion, user || null);

    // 三种 "需要解析" 的情况都走同一个错误码——
    //   1) 没 row（从未尝试过解析）
    //   2) 有 row 但 flowJson 空（之前 parseSkillFlow 写完 placeholder 后 LLM 调用挂了/中断，留下"卡住的解析中"状态）
    //   3) 有 row 但 flowJson 不是合法 JSON（迁移/损坏）
    // 上游 analyze-match route 的 shouldAutoParseSkillFlow 看到这串文字会自动触发 parseResolvedSkillFlow,
    // 用户不用手动去 Skill 详情页点"解析"，直接重试。
    if (!parsedFlow || !parsedFlow.flowJson || parsedFlow.flowJson.trim().length === 0) {
      return { success: false, error: "请先解析 Skill 流程" };
    }

    const session = await db.findSessionByTaskId(executionId);
    if (!session || !session.interactions) {
      return { success: false, error: "未找到执行记录或交互数据" };
    }

    let interactions: InteractionMessage[];
    try {
      interactions = typeof session.interactions === 'string' 
        ? JSON.parse(session.interactions) 
        : session.interactions;
    } catch {
      return { success: false, error: "交互数据解析失败" };
    }

    const interactionCount = Array.isArray(interactions) ? interactions.length : 0;
    
    // flowJson 已在上面非空校验过；这里防御解析失败（schema 漂移 / 损坏 row），
    // 抛出 "请先解析 Skill 流程" 让上游 auto-parse 路径接管,而不是 throw 一个
    // 无法识别的 SyntaxError 让用户看到"Unexpected token ..."这种没法 actionable 的报错。
    let flow: ParsedFlowResult;
    try {
      flow = JSON.parse(parsedFlow.flowJson);
    } catch {
      return { success: false, error: "请先解析 Skill 流程" };
    }
    
    // 不继承动态轨迹数据，每次都重新分析
    const allExtractedSteps = await extractStepsInBatches(client, model, interactions);
    const mergedSteps = withUiStepIndexes(mergeSteps(allExtractedSteps));
    const skillSpans = inferSkillSpans(interactions, mergedSteps, skillName || skillId, skillVersion);
    const evaluationSteps = buildMainSkillEvaluationSteps(mergedSteps, skillSpans);
    
    // 统一匹配
    const result = await matchStepsWithFlow(client, model, flow, evaluationSteps, mergedSteps, skillName || skillId, skillVersion, skillSpans);
    
    const dynamicMermaid = generateDynamicMermaidCode(flow, result.matches, result.skippedExpectedSteps, mergedSteps);

    await db.upsertExecutionMatch({
      executionId,
      skillId,
      skillVersion,
      user: user || null,
      mode: 'compare',
      matchJson: JSON.stringify(result),
      staticMermaid: parsedFlow.mermaidCode,
      dynamicMermaid,
      analysisText: JSON.stringify(result.problemSteps),
      extractedSteps: JSON.stringify(mergedSteps),
      interactionCount
    });

    return { 
      success: true, 
      result, 
      staticMermaid: parsedFlow.mermaidCode, 
      dynamicMermaid,
      flow,
      extractedSteps: mergedSteps,
      interactionCount
    };
    
  } catch (error) {
    const message = error instanceof Error ? error.message : "分析失败";
    console.error("Execution match error:", error);
    return { success: false, error: message };
  }
}

async function extractStepsInBatches(
  client: OpenAI,
  model: string,
  interactions: InteractionMessage[]
): Promise<ExtractedStep[]> {
  if (!Array.isArray(interactions) || interactions.length === 0) {
    return [];
  }

  const batches: InteractionMessage[][] = [];
  for (let i = 0; i < interactions.length; i += BATCH_SIZE) {
    batches.push(interactions.slice(i, i + BATCH_SIZE));
  }

  const batchPromises = batches.map(async (batch, batchIndex) => {
    const startIndex = batchIndex * BATCH_SIZE;
    const batchSummary = summarizeBatch(batch, startIndex);
    const prompt = generateStepExtractPrompt(batchSummary, batchIndex, startIndex);
    
    try {
      const response = await client.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: model,
        temperature: 0.3
      });

      const content = response.choices?.[0]?.message?.content;
      if (!content) return [];

      let jsonStr = content.trim();
      const match = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      if (match) {
        jsonStr = match[1];
      } else {
        const first = jsonStr.indexOf('{');
        const last = jsonStr.lastIndexOf('}');
        if (first !== -1 && last !== -1 && last >= first) {
          jsonStr = jsonStr.substring(first, last + 1);
        }
      }

      const result: BatchExtractResult = JSON.parse(jsonStr);
      return result.steps || [];
    } catch (e) {
      console.error(`Batch ${batchIndex} extract error:`, e);
      return [];
    }
  });

  const results = await Promise.all(batchPromises);
  return results.flat();
}

function summarizeBatch(batch: InteractionMessage[], startIndex: number): string {
  const summaries: string[] = [];

  batch.forEach((interaction, idx) => {
    const globalIndex = startIndex + idx;

    // OTEL / upload 走的"归一化"形态:每条 interaction 同时带
    // requestMessages + responseMessage(+ toolCall),代表一轮 LLM 调用。
    // 老格式则是单条 {role, content}。两种都要 cover。
    const hasNormalizedShape = Array.isArray(interaction.requestMessages)
      || interaction.responseMessage !== undefined
      || interaction.toolCall !== undefined
      || (Array.isArray(interaction.toolCalls) && interaction.toolCalls.length > 0);

    if (hasNormalizedShape) {
      const parts: string[] = [];

      // 最近一条 user 消息 —— 代表本轮 LLM 被驱动去做什么
      if (Array.isArray(interaction.requestMessages) && interaction.requestMessages.length > 0) {
        const lastUser = [...interaction.requestMessages].reverse().find(m => m?.role === 'user');
        if (lastUser) {
          const userText = extractInteractionText(lastUser.content).slice(0, 200);
          if (userText) parts.push(`USER: ${userText}`);
        }
      }

      // assistant 输出 —— 代表本轮决策/回复
      if (interaction.responseMessage) {
        const asText = extractInteractionText(interaction.responseMessage.content).slice(0, 300);
        if (asText) parts.push(`ASSISTANT: ${asText}`);
      }

      const toolNames = collectToolCallNames(interaction);
      if (toolNames.length > 0) parts.push(`[工具调用: ${toolNames.join(', ')}]`);

      if (parts.length > 0) {
        summaries.push(`[${globalIndex}] ${parts.join(' | ')}`);
        return;
      }
      // 归一化形态但啥实质内容也没有,fallthrough 到老格式分支兜底
    }

    // 老格式:{role, content}
    const role = interaction.role || 'unknown';
    let content = '';
    if (typeof interaction.content === 'string') {
      content = interaction.content.substring(0, 300);
    } else if (Array.isArray(interaction.content)) {
      content = extractInteractionText(interaction.content).substring(0, 300);
      const toolNames = collectToolCallNames(interaction);
      if (toolNames.length > 0) content += ` [工具调用: ${toolNames.join(', ')}]`;
    }

    summaries.push(`[${globalIndex}] ${role.toUpperCase()}: ${content}${content.length >= 300 ? '...' : ''}`);
  });

  return summaries.join('\n');
}

function mergeSteps(steps: ExtractedStep[]): ExtractedStep[] {
  if (steps.length === 0) {
    return [];
  }

  return [...steps].sort((a, b) => a.dialogStartIndex - b.dialogStartIndex);
}

function withUiStepIndexes(steps: ExtractedStep[]): ExtractedStep[] {
  return steps.map((step, index) => ({ ...step, uiStepIndex: index }));
}

function buildMainSkillEvaluationSteps(steps: ExtractedStep[], skillSpans: AlignmentSkillSpan[]): EvaluationStep[] {
  if (steps.length === 0) return [];

  const childSpans = skillSpans
    .filter(span => span.trigger !== 'primary')
    .sort((a, b) => a.startActualStepIndex - b.startActualStepIndex);
  if (childSpans.length === 0) {
    return steps.map(step => evaluationStepForActual(step));
  }

  const sortedSteps = [...steps].sort((a, b) => a.dialogStartIndex - b.dialogStartIndex);
  const evaluationSteps: EvaluationStep[] = [];
  let index = 0;

  while (index < sortedSteps.length) {
    const step = sortedSteps[index];
    const activeSpans = childSpans.filter(span => spanOverlapsExtractedStep(span, step));
    if (activeSpans.length === 0) {
      evaluationSteps.push(evaluationStepForActual(step));
      index += 1;
      continue;
    }

    const groupSteps: ExtractedStep[] = [];
    const groupSpans: AlignmentSkillSpan[] = [];
    let groupStart = Math.min(...activeSpans.map(span => span.startActualStepIndex));
    let groupEnd = Math.max(...activeSpans.map(span => span.endActualStepIndex));

    while (index < sortedSteps.length) {
      const current = sortedSteps[index];
      const currentSpans = childSpans.filter(span =>
        spanOverlapsExtractedStep(span, current)
        || (span.startActualStepIndex <= groupEnd && span.endActualStepIndex >= groupStart)
      );
      const currentUiIndex = uiStepIndexOf(current);
      if (currentUiIndex > groupEnd && currentSpans.length === 0) break;

      groupSteps.push(current);
      for (const span of currentSpans) {
        if (!groupSpans.includes(span)) groupSpans.push(span);
      }
      groupStart = Math.min(groupStart, currentUiIndex, ...currentSpans.map(span => span.startActualStepIndex));
      groupEnd = Math.max(groupEnd, currentUiIndex, ...currentSpans.map(span => span.endActualStepIndex));
      index += 1;
    }

    const labels = dedupeStrings(groupSpans.map(spanLabel));
    const labelText = labels.length > 0 ? labels.join('、') : '子 Skill';
    evaluationSteps.push({
      evaluationStepId: `delegate-${groupStart}-${groupEnd}`,
      uiStepIndexes: groupSteps.map(uiStepIndexOf),
      name: `委派 ${labelText} 执行子 Skill`,
      description: `主 Skill 视角的委派节点，覆盖 ${groupSteps.length} 个子 Skill 内部步骤；该区间内部行为不参与主 Skill 匹配。`,
      type: 'action',
    });
  }

  return evaluationSteps;
}

function evaluationStepForActual(step: ExtractedStep): EvaluationStep {
  const uiStepIndex = uiStepIndexOf(step);
  return {
    evaluationStepId: `main-${uiStepIndex}`,
    uiStepIndexes: [uiStepIndex],
    name: step.name,
    description: step.description,
    type: step.type,
  };
}

function uiStepIndexOf(step: ExtractedStep): number {
  return typeof step.uiStepIndex === 'number' ? step.uiStepIndex : step.dialogStartIndex;
}

function spanOverlapsExtractedStep(span: AlignmentSkillSpan, step: ExtractedStep): boolean {
  const uiStepIndex = uiStepIndexOf(step);
  return span.startActualStepIndex <= uiStepIndex && span.endActualStepIndex >= uiStepIndex;
}

async function matchStepsWithFlow(
  client: OpenAI,
  model: string,
  flow: ParsedFlowResult,
  evaluationSteps: EvaluationStep[],
  fullSteps: ExtractedStep[],
  skillName: string,
  skillVersion?: number,
  skillSpans?: AlignmentSkillSpan[],
): Promise<ExecutionMatchResult> {
  const stepsJson = JSON.stringify(evaluationSteps, null, 2);
  const prompt = generateExecutionMatchPrompt(flow, stepsJson, skillName);

  const response = await client.chat.completions.create({
    messages: [{ role: "user", content: prompt }],
    model: model,
    temperature: 0.3
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM 返回内容为空");
  }

  appendLog('execution_match', { skillId: skillName }, { raw_output: content });

  let jsonStr = content.trim();
  const match = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (match) {
    jsonStr = match[1];
  } else {
    const first = jsonStr.indexOf('{');
    const last = jsonStr.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last >= first) {
      jsonStr = jsonStr.substring(first, last + 1);
    }
  }

  const parsed: ExecutionMatchResult = JSON.parse(jsonStr);
  return ensureTraceSkillAlignment(parsed, flow, fullSteps, evaluationSteps, skillName, skillVersion, skillSpans);
}

function ensureTraceSkillAlignment(
  result: ExecutionMatchResult,
  flow: ParsedFlowResult,
  fullSteps: ExtractedStep[],
  evaluationSteps: EvaluationStep[],
  skillName: string,
  skillVersion?: number,
  knownSkillSpans?: AlignmentSkillSpan[],
): ExecutionMatchResult {
  const expectedSteps: AlignmentExpectedStep[] = flow.steps.map((step, index) => ({
    id: step.id,
    name: step.name,
    description: step.description,
    type: step.type,
    order: index,
  }));

  const rawMatches = Array.isArray(result.matches) ? result.matches : [];
  const evaluationMatches = normalizeMatches(rawMatches, evaluationSteps);
  const skippedExpectedSteps = Array.isArray(result.skippedExpectedSteps) ? result.skippedExpectedSteps : [];
  const rawProblemSteps = Array.isArray(result.problemSteps) ? result.problemSteps : [];
  const skillSpans = knownSkillSpans || [];
  const childSpans = skillSpans.filter(span => span.trigger !== 'primary');
  const evaluationById = new Map<string, StepMatch>();
  const evaluationByUiIndex = new Map<number, StepMatch>();
  for (const match of evaluationMatches) {
    if (match.evaluationStepId) evaluationById.set(match.evaluationStepId, match);
    if (typeof match.actualStepIndex === 'number') evaluationByUiIndex.set(match.actualStepIndex, match);
  }
  const evaluationByDelegateStart = new Map<number, StepMatch>();
  for (const step of evaluationSteps) {
    if (!step.evaluationStepId.startsWith('delegate-')) continue;
    const match = evaluationById.get(step.evaluationStepId);
    const start = Math.min(...step.uiStepIndexes);
    if (match && Number.isFinite(start)) evaluationByDelegateStart.set(start, match);
  }

  const evaluatedSkillSpans = skillSpans.map(span => {
    if (span.trigger === 'primary') return span;
    const evaluation = evaluationByDelegateStart.get(span.startActualStepIndex);
    if (!evaluation) return span;
    const evaluationStatus = toEvaluationStatus(evaluation.matchStatus);
    return {
      ...span,
      expectedStepId: evaluation.expectedStepId,
      expectedStepName: evaluation.expectedStepName,
      evaluationStatus,
      evaluationReason: evaluation.matchReason,
    };
  });

  const mappings: AlignmentMapping[] = fullSteps
    .slice()
    .sort((a, b) => a.dialogStartIndex - b.dialogStartIndex)
    .map(step => {
      const uiStepIndex = uiStepIndexOf(step);
      const activeChildSpans = childSpans.filter(span => spanOverlapsExtractedStep(span, step));
      if (activeChildSpans.length > 0) {
        const evaluated = activeChildSpans
          .map(span => evaluationByDelegateStart.get(span.startActualStepIndex))
          .find(Boolean);
        return {
          actualStepIndex: uiStepIndex,
          expectedStepId: evaluated?.expectedStepId,
          expectedStepName: evaluated?.expectedStepName,
          status: 'delegated' as const,
          reason: evaluated?.matchReason || `该步骤位于子 Skill 执行区间：${activeChildSpans.map(spanLabel).join('、')}，不参与主 Skill 内容匹配。`,
        };
      }

      if (isNonBusinessTransitionStep(step)) {
        return {
          actualStepIndex: uiStepIndex,
          status: 'non_business' as const,
          reason: '该步骤属于上下文收集、环境预热或流程衔接的过渡操作，不参与主 Skill 业务流程评分。',
        };
      }

      const match = evaluationByUiIndex.get(uiStepIndex);
      return {
        actualStepIndex: uiStepIndex,
        expectedStepId: match?.expectedStepId,
        expectedStepName: match?.expectedStepName,
        status: toEvaluationStatus(match?.matchStatus) || 'unexpected',
        reason: match?.matchReason || 'LLM 未返回该主流程步骤的匹配记录，按未匹配步骤兜底。',
      };
    });

  const actualSteps: AlignmentActualStep[] = mappings
    .slice()
    .sort((a, b) => a.actualStepIndex - b.actualStepIndex)
    .map(mapping => {
      const extracted = fullSteps.find(step => uiStepIndexOf(step) === mapping.actualStepIndex);
      return {
        index: mapping.actualStepIndex,
        action: extracted?.name || `实际步骤 #${mapping.actualStepIndex}`,
        type: extracted?.type || 'action',
        description: extracted?.description,
        dialogStartIndex: extracted?.dialogStartIndex,
        dialogEndIndex: extracted?.dialogEndIndex,
      };
    });

  const delegatedIndexes = new Set(mappings.filter(mapping => mapping.status === 'delegated').map(mapping => mapping.actualStepIndex));
  const problemSteps = rawProblemSteps
    .map(problem => normalizeProblemStep(problem, evaluationSteps))
    .filter(problem => typeof problem.stepIndex !== 'number' || !delegatedIndexes.has(problem.stepIndex));
  const problemByActual = new Map<number, ProblemStep>();
  const problemByName = new Map<string, ProblemStep>();
  for (const problem of problemSteps) {
    if (typeof problem.stepIndex === 'number') problemByActual.set(problem.stepIndex, problem);
    problemByName.set(problem.stepName, problem);
  }

  const violations: AlignmentViolation[] = [];
  for (const mapping of mappings) {
    if (mapping.status === 'matched' || mapping.status === 'delegated' || mapping.status === 'non_business') continue;
    const actual = actualSteps.find(step => step.index === mapping.actualStepIndex);
    const problem = problemByActual.get(mapping.actualStepIndex)
      || (mapping.expectedStepName ? problemByName.get(mapping.expectedStepName) : undefined)
      || (actual?.action ? problemByName.get(actual.action) : undefined);
    violations.push({
      kind: mapping.status,
      actualStepIndex: mapping.actualStepIndex,
      expectedStepId: mapping.expectedStepId,
      expectedStepName: mapping.expectedStepName,
      severity: mapping.status === 'unexpected' ? 'medium' : 'low',
      problem: problem?.problem || mapping.reason || (mapping.status === 'unexpected' ? '实际执行了 Skill 预期之外的步骤。' : '实际执行只覆盖了部分 Skill 预期。'),
      suggestion: problem?.suggestion,
      evidenceInteractionIndexes: interactionIndexesForStep(actual),
    });
  }
  for (const skipped of skippedExpectedSteps) {
    const problem = problemByName.get(skipped.expectedStepName);
    violations.push({
      kind: 'skipped',
      expectedStepId: skipped.expectedStepId,
      expectedStepName: skipped.expectedStepName,
      severity: 'medium',
      problem: problem?.problem || 'Skill 中规定了该步骤，但实际执行流程没有覆盖。',
      suggestion: problem?.suggestion,
    });
  }

  const fullMatches = mappings.map(mapping => {
    const actual = actualSteps.find(step => step.index === mapping.actualStepIndex);
    return {
      expectedStepId: mapping.expectedStepId,
      expectedStepName: mapping.expectedStepName,
      actualStepIndex: mapping.actualStepIndex,
      actualAction: actual?.action || `实际步骤 #${mapping.actualStepIndex}`,
      matchStatus: mapping.status,
      matchReason: mapping.reason || '',
    };
  });

  const alignment: TraceSkillAlignment = {
    actualSteps,
    expectedSteps,
    mappings,
    skippedExpectedSteps,
    skillSpans: evaluatedSkillSpans,
    violations,
    summary: summarizeMappings(mappings, skippedExpectedSteps, result.summary),
  };

  return {
    ...result,
    matches: fullMatches,
    skippedExpectedSteps,
    problemSteps,
    summary: alignment.summary,
    alignment,
  };
}

function normalizeMatches(rawMatches: StepMatch[], steps: EvaluationStep[]): StepMatch[] {
  const usableMatches = rawMatches.filter(match => match.matchStatus !== 'skipped');
  const byEvaluationId = new Map<string, StepMatch>();
  usableMatches.forEach(match => {
    if (match.evaluationStepId) byEvaluationId.set(match.evaluationStepId, match);
  });
  const usedLegacyIndexes = new Set<number>();

  return [...steps]
    .sort((a, b) => Math.min(...a.uiStepIndexes) - Math.min(...b.uiStepIndexes))
    .map((step, stepOrdinal) => {
      const startIndex = Math.min(...step.uiStepIndexes);
      const picked = byEvaluationId.get(step.evaluationStepId)
        || usableMatches.find((match, index) => {
          if (usedLegacyIndexes.has(index) || typeof match.actualStepIndex !== 'number') return false;
          return step.uiStepIndexes.includes(match.actualStepIndex);
        })
        || usableMatches.find((match, index) => {
          if (usedLegacyIndexes.has(index) || match.evaluationStepId || typeof match.actualStepIndex === 'number') return false;
          return index === stepOrdinal;
        });
      if (!picked) {
        return {
          evaluationStepId: step.evaluationStepId,
          expectedStepId: undefined,
          expectedStepName: undefined,
          actualStepIndex: startIndex,
          actualAction: step.name,
          matchStatus: 'unexpected',
          matchReason: 'LLM 未返回该主流程步骤的匹配记录，按未匹配步骤兜底。',
        };
      }
      const pickedIndex = usableMatches.indexOf(picked);
      if (pickedIndex >= 0) usedLegacyIndexes.add(pickedIndex);

      return {
        ...picked,
        evaluationStepId: step.evaluationStepId,
        actualStepIndex: startIndex,
        actualAction: step.name,
      };
    });
}

function normalizeProblemStep(problem: ProblemStep, steps: EvaluationStep[]): ProblemStep {
  if (!problem.evaluationStepId) return problem;
  const step = steps.find(item => item.evaluationStepId === problem.evaluationStepId);
  if (!step) return problem;
  return {
    ...problem,
    stepIndex: Math.min(...step.uiStepIndexes),
  };
}

function isNonBusinessTransitionStep(step: ExtractedStep): boolean {
  const text = `${step.name || ''} ${step.description || ''}`.toLowerCase();
  if (!text.trim()) return false;
  const patterns = [
    /背景代理|后台代理|探索代码库|收集上下文|上下文信息|上下文收集|准备后续/,
    /读取\s*skill|加载\s*skill|查看\s*skill|skill\.md/,
    /查看原始日志|原始日志上下文|grep|less|cat|sed|tail|head/,
    /读取文件|查看文件|浏览文件|检查目录|列出目录|扫描目录/,
    /环境预热|初始化环境|准备环境|确认工作区|检查工作区/,
  ];
  return patterns.some(pattern => pattern.test(text));
}

function toEvaluationStatus(status: StepMatch['matchStatus'] | undefined): 'matched' | 'partial' | 'unexpected' | 'non_business' | undefined {
  if (status === 'matched' || status === 'partial' || status === 'unexpected' || status === 'non_business') return status;
  return undefined;
}

function summarizeMappings(
  mappings: AlignmentMapping[],
  skippedExpectedSteps: SkippedExpectedStep[],
  fallback?: MatchSummary,
): MatchSummary {
  const matchedSteps = mappings.filter(mapping => mapping.status === 'matched').length;
  const partialSteps = mappings.filter(mapping => mapping.status === 'partial').length;
  const unexpectedSteps = mappings.filter(mapping => mapping.status === 'unexpected').length;
  const delegatedSteps = mappings.filter(mapping => mapping.status === 'delegated').length;
  const nonBusinessSteps = mappings.filter(mapping => mapping.status === 'non_business').length;
  const skippedSteps = skippedExpectedSteps.length;
  const totalSteps = mappings.length;
  const denominator = totalSteps - nonBusinessSteps + skippedSteps;
  const rawScore = denominator > 0
    ? (matchedSteps + delegatedSteps + partialSteps * 0.5 - unexpectedSteps * 0.2) / denominator
    : 1;

  return {
    totalSteps,
    matchedSteps,
    partialSteps,
    unexpectedSteps,
    delegatedSteps,
    nonBusinessSteps,
    skippedSteps,
    orderViolations: fallback?.orderViolations ?? 0,
    overallScore: Math.max(0, Math.min(1, rawScore)),
  };
}

function interactionIndexesForStep(step: AlignmentActualStep | undefined): number[] | undefined {
  if (!step) return undefined;
  return [step.index];
}

interface SkillRef {
  name: string;
  version?: number;
  trigger: AlignmentSkillSpan['trigger'];
}

function inferSkillSpans(
  interactions: InteractionMessage[],
  steps: ExtractedStep[],
  primarySkillName: string,
  primarySkillVersion?: number,
): AlignmentSkillSpan[] {
  const spans: AlignmentSkillSpan[] = [];
  if (steps.length > 0) {
    spans.push({
      skillName: primarySkillName,
      version: primarySkillVersion,
      startActualStepIndex: Math.min(...steps.map(uiStepIndexOf)),
      endActualStepIndex: Math.max(...steps.map(uiStepIndexOf)),
      trigger: 'primary',
    });
  }

  const directSpans = inferDirectSkillCallSpans(interactions, steps, primarySkillName);
  const subagentSpans = inferSubagentSkillSpans(interactions, steps, primarySkillName);
  for (const span of [...directSpans, ...subagentSpans]) {
    if (span.skillName === primarySkillName && span.trigger !== 'subagent') continue;
    addOrMergeSpan(spans, span);
  }

  return spans;
}

function inferDirectSkillCallSpans(
  interactions: InteractionMessage[],
  steps: ExtractedStep[],
  primarySkillName: string,
): AlignmentSkillSpan[] {
  const spans: AlignmentSkillSpan[] = [];
  const childCallIndexes = collectChildSkillCallIndexes(interactions, primarySkillName);
  interactions.forEach((interaction, index) => {
    const refs = skillRefsFromInteraction(interaction)
      .filter(ref => ref.name && ref.name !== primarySkillName);
    if (refs.length === 0) return;
    const start = uiStepIndexAtOrAfterInteraction(steps, index);
    if (start == null) return;
    const nextCallIndex = childCallIndexes.find(callIndex => callIndex > index);
    const end = nextCallIndex != null
      ? Math.max(start, uiStepIndexBeforeInteraction(steps, nextCallIndex) ?? start)
      : Math.max(start, lastUiStepIndex(steps) ?? start);
    for (const ref of refs) {
      spans.push({
        skillName: ref.name,
        version: ref.version,
        startActualStepIndex: start,
        endActualStepIndex: end,
        trigger: ref.trigger,
      });
    }
  });
  return spans;
}

function inferSubagentSkillSpans(
  interactions: InteractionMessage[],
  steps: ExtractedStep[],
  primarySkillName: string,
): AlignmentSkillSpan[] {
  const tree = buildAgentCallTree(interactions as unknown as RawInteraction[]);
  if (!tree) return [];

  const taskRefsByChildId = new Map<string, SkillRef[]>();
  const taskStartByChildId = new Map<string, number>();
  walkTree(tree, node => {
    for (const event of node.events) {
      if (event.kind !== 'task' || !event.spawnedChildId) continue;
      taskRefsByChildId.set(event.spawnedChildId, skillRefsFromTaskEvent(event));
      if (typeof event.interactionIndex === 'number') taskStartByChildId.set(event.spawnedChildId, event.interactionIndex);
    }
  });

  const spans: AlignmentSkillSpan[] = [];
  walkTree(tree, node => {
    if (!node.parentId) return;
    const refs = [
      ...(taskRefsByChildId.get(node.id) || []),
      ...skillRefsFromAgentNode(node),
    ].filter(ref => ref.name && ref.name !== primarySkillName);
    const uniqueRefs = dedupeSkillRefs(refs);
    if (uniqueRefs.length === 0) return;

    const range = actualStepRangeForInteractionIndexes(steps, node.interactionIndices);
    if (!range) return;
    const taskStart = taskStartByChildId.get(node.id);
    const start = taskStart != null
      ? Math.max(range.start, uiStepIndexAtOrAfterInteraction(steps, taskStart) ?? range.start)
      : range.start;
    for (const ref of uniqueRefs) {
      spans.push({
        skillName: ref.name,
        version: ref.version,
        startActualStepIndex: start,
        endActualStepIndex: Math.max(start, range.end),
        trigger: 'subagent',
      });
    }
  });
  return spans;
}

function skillRefsFromAgentNode(node: AgentNode): SkillRef[] {
  const refs: SkillRef[] = [];
  for (const event of node.events) {
    if (event.kind === 'skill') refs.push(...skillRefsFromSkillArgs(event.args, 'invoked'));
    if (event.kind === 'tool' && event.name === 'load_skill') refs.push(...skillRefsFromSkillArgs(event.args, 'load_skill'));
    if (event.kind === 'task') refs.push(...skillRefsFromTaskEvent(event));
  }
  return dedupeSkillRefs(refs);
}

function skillRefsFromTaskEvent(event: AgentEvent): SkillRef[] {
  const args = event.args;
  if (!args || typeof args !== 'object') return [];
  return skillRefsFromLoadSkills(args.load_skills || args.loadSkills, 'subagent');
}

function skillRefsFromInteraction(interaction: InteractionMessage): SkillRef[] {
  const refs: SkillRef[] = [];
  for (const call of collectToolCallPayloads(interaction)) {
    const name = call.name;
    const args = call.args;
    if (name === 'skill') refs.push(...skillRefsFromSkillArgs(args, 'invoked'));
    if (name === 'load_skill') refs.push(...skillRefsFromSkillArgs(args, 'load_skill'));
    if (name === 'task' && args && typeof args === 'object') {
      const record = args as Record<string, unknown>;
      refs.push(...skillRefsFromLoadSkills(record.load_skills || record.loadSkills, 'subagent'));
    }
  }
  return dedupeSkillRefs(refs);
}

function collectChildSkillCallIndexes(interactions: InteractionMessage[], primarySkillName: string): number[] {
  return interactions
    .map((interaction, index) => ({ index, refs: skillRefsFromInteraction(interaction) }))
    .filter(item => item.refs.some(ref => ref.name && ref.name !== primarySkillName))
    .map(item => item.index)
    .sort((a, b) => a - b);
}

function collectToolCallPayloads(interaction: InteractionMessage): Array<{ name?: string; args?: unknown }> {
  const calls: Array<{ name?: string; args?: unknown }> = [];
  const pushCall = (raw: { name?: string; arguments?: unknown; function?: { name?: string; arguments?: unknown } } | undefined) => {
    if (!raw) return;
    const name = raw.name || raw.function?.name;
    const argsRaw = raw.arguments ?? raw.function?.arguments;
    calls.push({ name, args: parseMaybeJson(argsRaw) });
  };
  pushCall(interaction.toolCall);
  if (Array.isArray(interaction.toolCalls)) interaction.toolCalls.forEach(pushCall);
  if (Array.isArray(interaction.tool_calls)) interaction.tool_calls.forEach(pushCall);
  if (Array.isArray(interaction.responseMessage?.tool_calls)) interaction.responseMessage.tool_calls.forEach(pushCall);
  if (Array.isArray(interaction.content)) {
    for (const content of interaction.content) {
      if ((content.type === 'toolCall' || content.type === 'tool_use') && content.name) {
        const toolContent = content as InteractionContent & { arguments?: unknown; input?: unknown };
        calls.push({ name: content.name, args: parseMaybeJson(toolContent.arguments || toolContent.input) });
      }
    }
  }
  return calls;
}

function skillRefsFromSkillArgs(args: unknown, trigger: AlignmentSkillSpan['trigger']): SkillRef[] {
  if (!args || typeof args !== 'object') return [];
  const obj = args as Record<string, unknown>;
  const name = stringValue(obj.name) || stringValue(obj.skill) || stringValue(obj.skillName) || stringValue(obj.skill_name);
  if (!name) return [];
  return [{ name, version: numberValue(obj.version ?? obj.skillVersion ?? obj.skill_version), trigger }];
}

function skillRefsFromLoadSkills(value: unknown, trigger: AlignmentSkillSpan['trigger']): SkillRef[] {
  if (!Array.isArray(value)) return [];
  const refs: SkillRef[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) {
      refs.push({ name: item.trim(), trigger });
      continue;
    }
    if (item && typeof item === 'object') {
      refs.push(...skillRefsFromSkillArgs(item, trigger));
    }
  }
  return refs;
}

function actualStepRangeForInteractionIndexes(steps: ExtractedStep[], indexes: number[]): { start: number; end: number } | null {
  if (indexes.length === 0) return null;
  const indexSet = new Set(indexes);
  const covered = steps.filter(step => {
    for (let i = step.dialogStartIndex; i <= step.dialogEndIndex; i += 1) {
      if (indexSet.has(i)) return true;
    }
    return false;
  });
  if (covered.length === 0) return null;
  return {
    start: Math.min(...covered.map(uiStepIndexOf)),
    end: Math.max(...covered.map(uiStepIndexOf)),
  };
}

function uiStepIndexAtOrAfterInteraction(steps: ExtractedStep[], interactionIndex: number): number | undefined {
  const sortedSteps = [...steps].sort((a, b) => a.dialogStartIndex - b.dialogStartIndex);
  const startingAfter = sortedSteps.find(step => step.dialogStartIndex >= interactionIndex);
  if (startingAfter) return uiStepIndexOf(startingAfter);
  const containing = sortedSteps.find(step => step.dialogStartIndex <= interactionIndex && step.dialogEndIndex >= interactionIndex);
  if (containing) return uiStepIndexOf(containing);
  return undefined;
}

function uiStepIndexBeforeInteraction(steps: ExtractedStep[], interactionIndex: number): number | undefined {
  const before = steps
    .filter(step => step.dialogStartIndex < interactionIndex)
    .sort((a, b) => uiStepIndexOf(b) - uiStepIndexOf(a))[0];
  return before ? uiStepIndexOf(before) : undefined;
}

function lastUiStepIndex(steps: ExtractedStep[]): number | undefined {
  if (steps.length === 0) return undefined;
  return Math.max(...steps.map(uiStepIndexOf));
}

function addOrMergeSpan(spans: AlignmentSkillSpan[], incoming: AlignmentSkillSpan) {
  const existing = spans.find(span =>
    span.skillName === incoming.skillName
    && span.version === incoming.version
    && (span.trigger === incoming.trigger || (span.trigger !== 'primary' && incoming.trigger !== 'primary'))
    && rangesOverlap(span, incoming)
  );
  if (!existing) {
    spans.push(incoming);
    return;
  }
  existing.startActualStepIndex = Math.min(existing.startActualStepIndex, incoming.startActualStepIndex);
  existing.endActualStepIndex = Math.max(existing.endActualStepIndex, incoming.endActualStepIndex);
}

function rangesOverlap(a: AlignmentSkillSpan, b: AlignmentSkillSpan): boolean {
  return a.startActualStepIndex <= b.endActualStepIndex + 1 && b.startActualStepIndex <= a.endActualStepIndex + 1;
}

function dedupeSkillRefs(refs: SkillRef[]): SkillRef[] {
  const out: SkillRef[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = `${ref.name}:${ref.version ?? ''}:${ref.trigger}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function dedupeStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function spanLabel(span: AlignmentSkillSpan): string {
  return span.version != null ? `${span.skillName} v${span.version}` : span.skillName;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function summarizeInteractions(interactions: InteractionMessage[]): string {
  if (!Array.isArray(interactions) || interactions.length === 0) {
    return "无交互记录";
  }

  const summaries: string[] = [];
  
  interactions.forEach((interaction, index) => {
    const msg = interaction;
    const role = msg.role || 'unknown';
    
    let content = '';
    if (typeof msg.content === 'string') {
      content = msg.content.substring(0, 200);
    } else if (Array.isArray(msg.content)) {
      const textParts = msg.content
        .filter((c: InteractionContent) => c.type === 'text')
        .map((c: InteractionContent) => c.text || '')
        .join(' ');
      content = textParts.substring(0, 200);
      
      const toolCalls = msg.content.filter((c: InteractionContent) => 
        c.type === 'toolCall' || c.type === 'tool_use'
      );
      if (toolCalls.length > 0) {
        content += ` [工具调用: ${toolCalls.map((t: InteractionContent) => t.name).join(', ')}]`;
      }
    }
    
    summaries.push(`[${index}] ${role.toUpperCase()}: ${content}${content.length >= 200 ? '...' : ''}`);
  });

  return summaries.join('\n');
}

export async function getParsedFlow(skillId: string, version: number, user?: string | null) {
  return db.findParsedFlow(skillId, version, user || null);
}

export async function getExecutionMatch(executionId: string) {
  return db.findExecutionMatch(executionId);
}

interface DynamicStep {
  id: string;
  name: string;
  type: 'action' | 'decision' | 'output';
}

export interface ExtractedStep {
  uiStepIndex?: number;
  name: string;
  description: string;
  dialogStartIndex: number;
  dialogEndIndex: number;
  type: 'action' | 'decision' | 'output';
}

interface EvaluationStep {
  evaluationStepId: string;
  uiStepIndexes: number[];
  name: string;
  description?: string;
  type: 'action' | 'decision' | 'output';
}

interface BatchExtractResult {
  steps: ExtractedStep[];
}

interface DynamicAnalysisResult {
  steps: DynamicStep[];
  analysis: string;
}

export async function analyzeDynamicOnly(
  executionId: string,
  user?: string | null
): Promise<{ success: boolean; dynamicMermaid?: string; analysisText?: string; interactionCount?: number; error?: string }> {
  const { client, model } = await getLlmClient(user);
  
  if (!client || !client.apiKey) {
    return { success: false, error: "请在首页左上角的设置中配置 LLM" };
  }

  try {
    const session = await db.findSessionByTaskId(executionId);
    if (!session || !session.interactions) {
      return { success: false, error: "未找到执行记录或交互数据" };
    }

    let interactions: InteractionMessage[];
    try {
      interactions = typeof session.interactions === 'string' 
        ? JSON.parse(session.interactions) 
        : session.interactions;
    } catch {
      return { success: false, error: "交互数据解析失败" };
    }

    const interactionCount = Array.isArray(interactions) ? interactions.length : 0;

    await db.upsertExecutionMatch({
      executionId,
      skillId: null,
      skillVersion: null,
      user: user || null,
      mode: 'dynamic',
      matchJson: null,
      staticMermaid: null,
      dynamicMermaid: null,
      analysisText: null,
      extractedSteps: null,
      interactionCount
    });
    
    // 使用分批并行提取步骤（与 Skill 对比相同的逻辑）
    const allExtractedSteps = await extractStepsInBatches(client, model, interactions);
    const mergedSteps = mergeSteps(allExtractedSteps);
    
    // 调用匹配 LLM 生成 actualAction（使用与 Skill 对比相同规则的提示词）
    const matchResult = await generateDynamicOnlyMatchResult(client, model, mergedSteps);
    
    // 生成 Mermaid 图
    const dynamicMermaid = generateActualTrajectoryMermaidCode(matchResult.matches, mergedSteps);

    // 保存提取的步骤数据
    const stepsJson = JSON.stringify(mergedSteps);
    
    await db.upsertExecutionMatch({
      executionId,
      skillId: null,
      skillVersion: null,
      user: user || null,
      mode: 'dynamic',
      matchJson: JSON.stringify(matchResult),
      staticMermaid: null,
      dynamicMermaid,
      analysisText: null,
      extractedSteps: stepsJson,
      interactionCount
    });

    return { 
      success: true, 
      dynamicMermaid,
      interactionCount
    };
    
  } catch (error) {
    const message = error instanceof Error ? error.message : "分析失败";
    console.error("Dynamic analysis error:", error);
    return { success: false, error: message };
  }
}

interface DynamicOnlyMatchResult {
  matches: {
    actualStepIndex: number;
    actualAction: string;
    type: 'action' | 'decision' | 'output';
  }[];
}

async function generateDynamicOnlyMatchResult(
  client: OpenAI,
  model: string,
  steps: ExtractedStep[]
): Promise<DynamicOnlyMatchResult> {
  const stepsJson = JSON.stringify(steps, null, 2);
  const prompt = generateDynamicOnlyMatchPrompt(stepsJson);

  const response = await client.chat.completions.create({
    messages: [{ role: "user", content: prompt }],
    model: model,
    temperature: 0.3
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM 返回内容为空");
  }

  let jsonStr = content.trim();
  const match = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (match) {
    jsonStr = match[1];
  } else {
    const first = jsonStr.indexOf('{');
    const last = jsonStr.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last >= first) {
      jsonStr = jsonStr.substring(first, last + 1);
    }
  }

  return JSON.parse(jsonStr);
}

function generateActualTrajectoryMermaidCode(
  matches: DynamicOnlyMatchResult['matches'],
  extractedSteps: ExtractedStep[]
): string {
  const lines: string[] = ['flowchart LR'];
  
  matches.forEach((match, index) => {
    const nodeId = `S${index + 1}`;
    const dialogIndex = match.actualStepIndex;
    const label = sanitizeMermaidLabel(`#${dialogIndex} ${match.actualAction}`);
    const nodeType = match.type === 'decision' ? '{' + label + '}' : 
                     match.type === 'output' ? '((' + label + '))' :
                     '[' + label + ']';
    lines.push(`    ${nodeId}${nodeType}`);
  });

  for (let i = 0; i < matches.length - 1; i++) {
    const currentNode = `S${i + 1}`;
    const nextNode = `S${i + 2}`;
    lines.push(`    ${currentNode} --> ${nextNode}`);
  }

  // 添加颜色样式
  lines.push('');
  matches.forEach((match, index) => {
    const nodeId = `S${index + 1}`;
    const color = '#38bdf8'; // 蓝色
    lines.push(`    style ${nodeId} fill:${color},color:#0f172a`);
  });

  return lines.join('\n');
}

function generateDynamicOnlyPrompt(interactions: string): string {
  return `
你是一个专家，擅长分析 Agent 执行轨迹并提取执行流程。

实际执行轨迹：
---
${interactions}
---

你的任务是：
1. 分析执行轨迹，提取实际执行的步骤序列
2. 为每个步骤命名（具体、明确的中文描述）
3. 提供整体分析

步骤提取规则：

一、步骤划分原则
1. 完整性：一个步骤完成一个完整的子任务
2. 独立性：一个步骤可以独立理解和描述
3. 目的性：每个步骤有明确的业务目标
4. 原子性：步骤内部的操作是紧密相关的，不应再拆分

二、命名规范
1. 格式：动词 + 对象 + （可选）目的/结果
2. 必须具体、明确，禁止模糊命名
3. 正确示例：
   - "读取配置文件获取数据库连接参数"
   - "调用天气API获取城市天气数据"
   - "解析用户输入提取意图和实体"
4. 禁止示例：
   - "检查配置"（太模糊，应说明检查什么）
   - "分析结果"（太抽象，应说明分析什么结果）
   - "处理数据"（太笼统，应说明处理什么数据）

三、步骤类型
- action：执行操作（如：读取文件、调用API、写入数据库）
- decision：做出判断（如：判断权限、检查条件、验证数据）
- output：输出结果（如：生成报告、返回结果、输出错误信息）

四、步骤数量
- 不限制数量，但相似的连续操作应合并为一个步骤
- 同一操作多次执行（可能因为某些报错）应总结成一个步骤
- 每个步骤都应该有独立存在的价值

请只用 JSON 对象回复，格式如下：
{
  "steps": [
    {
      "id": "step-1",
      "name": "具体的步骤名称（动词+对象格式）",
      "type": "action"
    }
  ],
  "analysis": "详细分析执行过程，包括：执行的主要步骤、是否有异常操作、执行效率评估、改进建议等。"
}
`;
}

function generateDynamicOnlyMermaidCode(steps: DynamicStep[]): string {
  const lines: string[] = ['flowchart LR'];
  
  steps.forEach((step, index) => {
    const nodeId = `S${index + 1}`;
    const label = sanitizeMermaidLabel(`${index + 1}. ${step.name}`);
    const nodeType = step.type === 'decision' ? '{' + label + '}' : 
                     step.type === 'output' ? '((' + label + '))' :
                     '[' + label + ']';
    lines.push(`    ${nodeId}${nodeType}`);
  });

  for (let i = 0; i < steps.length - 1; i++) {
    const currentNode = `S${i + 1}`;
    const nextNode = `S${i + 2}`;
    lines.push(`    ${currentNode} --> ${nextNode}`);
  }

  lines.push('');
  
  steps.forEach((step, index) => {
    const nodeId = `S${index + 1}`;
    if (step.type === 'output') {
      lines.push(`    style ${nodeId} fill:#4ade80,color:#0f172a`);
    } else if (step.type === 'decision') {
      lines.push(`    style ${nodeId} fill:#fbbf24,color:#0f172a`);
    } else {
      lines.push(`    style ${nodeId} fill:#38bdf8,color:#0f172a`);
    }
  });

  return lines.join('\n');
}
