
import fs from 'fs';
import { OpenAI } from "openai";
import path from 'path';
import { getProxyConfig } from '@/lib/ingest/proxy-config';
import { getActiveConfig } from '@/lib/storage/server-config';
import {
    attachFailureAnchors,
    buildFaultPathSteps,
    formatFaultPathStepForPrompt,
    type FailureTraceAnchor,
} from '@/lib/engine/observability/fault-path';
import {
    extractSkillsFromClaudeSession,
    extractSkillsFromOpenClawSession,
    extractSkillsFromOpencodeSession,
    extractSkillsWithVersionsFromClaudeSession,
    extractSkillsWithVersionsFromOpenClawSession,
    extractSkillsWithVersionsFromOpencodeSession,
    normalizeInteractions as normalizeInteractionsCore,
    type InvokedSkill
} from '@/lib/shared/interaction-utils';

export type { InvokedSkill } from '@/lib/shared/interaction-utils';
export {
    extractSkillsFromClaudeSession,
    extractSkillsFromOpenClawSession,
    extractSkillsFromOpencodeSession,
    extractSkillsWithVersionsFromClaudeSession,
    extractSkillsWithVersionsFromOpenClawSession,
    extractSkillsWithVersionsFromOpencodeSession
} from '@/lib/shared/interaction-utils';

const LOG_FILE = path.join(process.cwd(), 'data', 'model_debug.jsonl');

function appendLog(stage: string, input: any, output: any) {
  try {
     const logDir = path.dirname(LOG_FILE);
     if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, {recursive: true});
     
     const record = {
         timestamp: new Date().toISOString(),
         stage,
         input,
         output
     };
     fs.appendFileSync(LOG_FILE, JSON.stringify(record) + '\n');
  } catch(e) { console.error('Log error', e); }
}

async function getLlmClient(user?: string | null) {
    const config = await getActiveConfig(user);
    if (!config) {
        return { client: null, model: null };
    }

    const apiKey = config.apiKey || 'no-api-key-required';
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

function getJudgmentTimeoutMs() {
  const raw = Number(process.env.JUDGMENT_TIMEOUT_MS || 300000);
  if (!Number.isFinite(raw) || raw <= 0) return 300000;
  return raw;
}

async function withTimeout<T>(fn: (options: { signal: AbortSignal; timeout: number }) => Promise<T>, label: string): Promise<T> {
  const ms = getJudgmentTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn({ signal: controller.signal, timeout: ms });
  } catch (e: any) {
    if (controller.signal.aborted) {
      throw new Error(`${label} timeout after ${ms}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export interface JudgmentResult {
  is_correct: boolean;
  score: number;
  reason?: string;
}

export interface JudgeCriteria {
  standard_answer_example?: string;
  root_causes?: { content: string; weight: number }[];
  key_actions?: { content: string; weight: number; controlFlowType?: 'required' | 'conditional' | 'loop' | 'optional' | 'handoff'; condition?: string; branchLabel?: string; loopCondition?: string; expectedMinCount?: number; expectedMaxCount?: number; groupId?: string }[];
  skill_definition?: string;
}

export async function judgeAnswer(
  userQuery: string,
  criteria: JudgeCriteria,
  actualAnswer: string,
  user?: string | null,
  executionSteps?: { name: string; description: string; type: string }[] | null
): Promise<JudgmentResult> {
  const { client, model } = await getLlmClient(user);
  if (!client || !client.apiKey) {
    console.warn("LLM Evaluation disabled or missing config. Skipping.");
    return { is_correct: false, score: 0, reason: "请在首页左上角的设置中配置 LLM" };
  }

  try {
    const rootCauses = criteria.root_causes || [];
    const keyActions = criteria.key_actions || [];
    
    const rcList = rootCauses.map((rc, i) => ({ id: `RC-${i}`, ...rc }));
    const kaList = keyActions.map((ka, i) => ({ id: `KA-${i}`, ...ka }));
    
    const { generateJudgePrompt } = require('@/prompts/judge-prompt');

    const evaluations: any[] = [];

    if (rcList.length > 0) {
        const rcPrompt = generateJudgePrompt(userQuery, actualAnswer, rcList, [], criteria.skill_definition, 'root_causes');
        const rcResponse = await withTimeout(
            (options) => client.chat.completions.create(
                {
                    messages: [{ role: "user", content: rcPrompt }],
                    model: model,
                },
                options
            ),
            'RC Judgment API',
        );
        console.log(`[Judge API Debug] RC Model: ${model}. Received response choices:`, rcResponse?.choices?.length);
        const rcContent = rcResponse.choices?.[0]?.message?.content;
        appendLog('rc_evaluation', { prompt: rcPrompt }, { raw_output: rcContent });
        if (rcContent) {
            let jsonStr = rcContent.trim();
            const m = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
            if (m) jsonStr = m[1];
            else { const f = jsonStr.indexOf('{'); const l = jsonStr.lastIndexOf('}'); if (f !== -1 && l !== -1 && l >= f) jsonStr = jsonStr.substring(f, l + 1); }
            try { const rcResult = JSON.parse(jsonStr); evaluations.push(...(rcResult.evaluations || [])); } catch (e) { console.warn('[Judge] Failed to parse RC result:', e); }
        }
    }

    if (kaList.length > 0) {
        const stepsText = executionSteps && executionSteps.length > 0
            ? executionSteps.map((s, i) => `步骤${i + 1}: [${s.type}] ${s.name} - ${s.description}`).join('\n')
            : null;

        const kaPrompt = generateJudgePrompt(
            userQuery, 
            stepsText || actualAnswer, 
            [], kaList, 
            criteria.skill_definition, 
            'key_actions',
            stepsText ? stepsText : null
        );
        const kaResponse = await withTimeout(
            (options) => client.chat.completions.create(
                {
                    messages: [{ role: "user", content: kaPrompt }],
                    model: model,
                },
                options
            ),
            'KA Judgment API',
        );
        console.log(`[Judge API Debug] KA Model: ${model}. Received response choices:`, kaResponse?.choices?.length);
        const kaContent = kaResponse.choices?.[0]?.message?.content;
        appendLog('ka_evaluation', { prompt: kaPrompt }, { raw_output: kaContent });
        if (kaContent) {
            let jsonStr = kaContent.trim();
            const m = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
            if (m) jsonStr = m[1];
            else { const f = jsonStr.indexOf('{'); const l = jsonStr.lastIndexOf('}'); if (f !== -1 && l !== -1 && l >= f) jsonStr = jsonStr.substring(f, l + 1); }
            try { const kaResult = JSON.parse(jsonStr); evaluations.push(...(kaResult.evaluations || [])); } catch (e) { console.warn('[Judge] Failed to parse KA result:', e); }
        }
    }
    
    // --- Calculate Score in Code (to avoid LLM math errors) ---
    let totalWeightedScore = 0;
    let totalWeight = 0;
    const reasonLines: string[] = [];

    // Process Root Causes
    rcList.forEach(rc => {
        const ev = evaluations.find((e: any) => e.id === rc.id);
        const match = ev ? Math.max(0, Math.min(1, Number(ev.match_score))) : 0;
        const explanation = ev?.explanation || '未找到评分结果';
        
        totalWeightedScore += match * rc.weight;
        totalWeight += rc.weight;
        
        reasonLines.push(`1. **Root Cause** [${rc.content.replace(/\n/g, ' ')}]: ${(match * 100).toFixed(0)}% match. ${explanation} (Weight: ${rc.weight})`);
    });

    // Group key actions by groupId for conditional groups
    const keyActionsByGroup = new Map<string, typeof kaList>();
    const ungroupedActions: typeof kaList = [];

    for (const ka of kaList) {
        const groupId = (ka as any).groupId;
        const cfType = (ka as any).controlFlowType || 'required';
        
        if (cfType === 'conditional' && groupId) {
            if (!keyActionsByGroup.has(groupId)) {
                keyActionsByGroup.set(groupId, []);
            }
            keyActionsByGroup.get(groupId)!.push(ka);
        } else {
            ungroupedActions.push(ka);
        }
    }

    // Process conditional groups first (grouped by groupId)
    for (const [groupId, groupActions] of keyActionsByGroup) {
        // Find all evaluations for this group
        const groupEvaluations = groupActions.map(ka => {
            const ev = evaluations.find((e: any) => e.id === ka.id);
            const match = ev ? Math.max(0, Math.min(1, Number(ev.match_score))) : 0;
            const explanation = ev?.explanation || '未找到评分结果';
            return { ka, ev, match, explanation };
        });

        // Check if any branch has a match score > 0 or is triggered
        const triggeredBranch = groupEvaluations.find(ge => ge.match > 0 || !ge.explanation.includes('此分支未触发'));

        if (triggeredBranch) {
            // Only count the triggered branch
            const { ka, ev, match, explanation } = triggeredBranch;
            const branchLabel = (ka as any).branchLabel || '';
            
            totalWeightedScore += match * ka.weight;
            totalWeight += ka.weight;
            reasonLines.push(`2. **Key Action** [${ka.content.replace(/\n/g, ' ')}] (条件分支${branchLabel ? ' - ' + branchLabel : ''}): ${(match * 100).toFixed(0)}% match. ${explanation} (Weight: ${ka.weight})`);

            // Log other branches as skipped
            for (const ge of groupEvaluations) {
                if (ge.ka.id !== triggeredBranch.ka.id) {
                    reasonLines.push(`2. **Key Action** [${ge.ka.content.replace(/\n/g, ' ')}] (条件分支${(ge.ka as any).branchLabel ? ' - ' + (ge.ka as any).branchLabel : ''}): ${(ge.match * 100).toFixed(0)}% match. ${ge.explanation} (该分支未触发，不计入总分)`);
                }
            }
        } else {
            // No branch triggered - count the first branch as 0
            const firstBranch = groupEvaluations[0];
            const { ka, ev, match, explanation } = firstBranch;
            const branchLabel = (ka as any).branchLabel || '';
            
            totalWeightedScore += 0 * ka.weight; 
            totalWeight += ka.weight;
            reasonLines.push(`2. **Key Action** [${ka.content.replace(/\n/g, ' ')}] (条件分支${branchLabel ? ' - ' + branchLabel : ''}): ${(match * 100).toFixed(0)}% match. ${explanation} (所有分支均未触发，Weight: ${ka.weight})`);

            // Log other branches as skipped
            for (let i = 1; i < groupEvaluations.length; i++) {
                const ge = groupEvaluations[i];
                reasonLines.push(`2. **Key Action** [${ge.ka.content.replace(/\n/g, ' ')}] (条件分支${(ge.ka as any).branchLabel ? ' - ' + (ge.ka as any).branchLabel : ''}): ${(ge.match * 100).toFixed(0)}% match. ${ge.explanation} (该分支未触发，不计入总分)`);
            }
        }
    }

    // Process ungrouped key actions
    ungroupedActions.forEach(ka => {
        const ev = evaluations.find((e: any) => e.id === ka.id);
        const match = ev ? Math.max(0, Math.min(1, Number(ev.match_score))) : 0;
        const explanation = ev?.explanation || '未找到评分结果';
        const cfType = (ka as any).controlFlowType || 'required';

        if (cfType === 'optional') {
            reasonLines.push(`2. **Key Action** [${ka.content.replace(/\n/g, ' ')}] (可选): ${(match * 100).toFixed(0)}% match. ${explanation} (Weight: 0, 不扣分)`);
            return;
        }

        if (cfType === 'handoff') {
            totalWeightedScore += match * ka.weight;
            totalWeight += ka.weight;
            reasonLines.push(`2. **Key Action** [${ka.content.replace(/\n/g, ' ')}] (衔接): ${(match * 100).toFixed(0)}% match. ${explanation} (Weight: ${ka.weight})`);
            return;
        }

        if (cfType === 'loop') {
            const loopCondition = (ka as any).loopCondition || '';
            const minCount = (ka as any).expectedMinCount;
            const maxCount = (ka as any).expectedMaxCount;
            totalWeightedScore += match * ka.weight;
            totalWeight += ka.weight;
            reasonLines.push(`2. **Key Action** [${ka.content.replace(/\n/g, ' ')}] (循环${loopCondition ? ' - ' + loopCondition : ''}): ${(match * 100).toFixed(0)}% match. ${explanation} (Weight: ${ka.weight}, 预期次数: ${minCount ?? '?'}~${maxCount ?? '?'})`);
            return;
        }

        totalWeightedScore += match * ka.weight;
        totalWeight += ka.weight;
        
        reasonLines.push(`2. **Key Action** [${ka.content.replace(/\n/g, ' ')}]: ${(match * 100).toFixed(0)}% match. ${explanation} (Weight: ${ka.weight})`);
    });

    let finalScore = 0;
    if (totalWeight > 0) {
        finalScore = totalWeightedScore / totalWeight;
    } else {
        // Fallback if no valid criteria (should not happen given validations)
        finalScore = 0; 
    }

    // Format Reason
    const calculationDetails = reasonLines.map(line => {
        // Extract match score and weight from line
        // Line format: "1. **Root Cause** ...: 80% match. ... (Weight: 0.5)"
        const matchMatch = line.match(/(\d+)% match/);
        const weightMatch = line.match(/\(Weight: ([\d\.]+)\)/);
        
        if (matchMatch && weightMatch) {
            const score = (parseInt(matchMatch[1]) / 100).toFixed(1);
            const weight = parseFloat(weightMatch[1]).toFixed(1);
            return `${score}*${weight}`;
        }
        return null;
    }).filter(x => x).join(' + ');

    const weightDetails = reasonLines.map(line => {
         const weightMatch = line.match(/\(Weight: ([\d\.]+)\)/);
         return weightMatch ? parseFloat(weightMatch[1]).toFixed(1) : null;
    }).filter(x => x).join(' + ');

    const calculationStr = `**Calculation**: (${calculationDetails}) / (${weightDetails}) = ${totalWeightedScore.toFixed(2)} / ${totalWeight.toFixed(2)} = ${finalScore.toFixed(2)}`;
    reasonLines.push('', calculationStr);
    const finalReason = reasonLines.join('\n');

    return {
      is_correct: finalScore >= 0.8,
      score: finalScore,
      reason: finalReason,
    };

  } catch (error) {

    console.error("LLM Judgment Error:", error);
    const msg = String((error as any)?.message || '');
    if (msg.includes('timeout')) return { is_correct: false, score: 0, reason: "Judgment API failed: timeout" };
    return { is_correct: false, score: 0, reason: "Judgment API failed" };
  }
}

export interface AnalysisResult {
  query: string;
  skill: string;
  final_result: string;
}

export interface SkillImprovementItem {
  id: string;                          // e.g., "RC-0", "KA-1"
  type: 'root_cause' | 'key_action';
  content: string;                     // 评分标准内容
  match_score: number;                 // 实际得分 0.0-1.0
  explanation: string;                 // 扣分原因
  weight: number;
  is_skill_issue: boolean;             // 是否是 Skill 问题
  reasoning: string;                   // 判断依据
  improvement_suggestion?: string;     // Skill 改进建议
}

// 执行过程中的失败记录（如 API 错误、超时等）
export interface FailureItem {
  failure_type: string;
  description: string;
  context: string;
  recovery: string;
  step?: string;
  anchor_step_id?: string;
  trace_anchor?: FailureTraceAnchor;
}

export interface FailureAnalysisResult {
    failures: FailureItem[];
    skill_issues?: SkillImprovementItem[];  // 只包含确定是 Skill 问题的项目
}


/**
 * 解析 judgmentReason 中的评分项
 * 格式示例：
 * "1. **Root Cause** [问题描述...]: 50% match. 评分理由... (Weight: 0.5)"
 */
function parseEvaluationItemsFromReason(judgmentReason: string): Array<{
    id: string;
    type: 'root_cause' | 'key_action';
    content: string;
    match_score: number;
    explanation: string;
    weight: number;
}> {
    const items: Array<{
        id: string;
        type: 'root_cause' | 'key_action';
        content: string;
        match_score: number;
        explanation: string;
        weight: number;
    }> = [];
    
    if (!judgmentReason) return items;
    
    const lines = judgmentReason.split('\n');
    const itemIndex = { rc: 0, ka: 0 };
    
    for (const line of lines) {
        // 匹配 Root Cause 行
        // 格式: "1. **Root Cause** [内容...]: 50% match. 解释... (Weight: 0.5)"
        const rcMatch = line.match(/\*\*Root Cause\*\*\s*\[(.*?)\]\s*.*?:\s*(\d+)%\s*match\.\s*(.+?)\s*\(Weight:\s*([\d.]+)\)/);
        if (rcMatch) {
            items.push({
                id: `RC-${itemIndex.rc++}`,
                type: 'root_cause',
                content: rcMatch[1].replace(/\.{3}$/, ''),  // 移除末尾的 "..."
                match_score: parseInt(rcMatch[2]) / 100,
                explanation: rcMatch[3].trim(),
                weight: parseFloat(rcMatch[4])
            });
            continue;
        }
        
        // 匹配 Key Action 行
        const kaMatch = line.match(/\*\*Key Action\*\*\s*\[(.*?)\]\s*.*?:\s*(\d+)%\s*match\.\s*(.+?)\s*\(Weight:\s*([\d.]+)\)/);
        if (kaMatch) {
            items.push({
                id: `KA-${itemIndex.ka++}`,
                type: 'key_action',
                content: kaMatch[1].replace(/\.{3}$/, ''),
                match_score: parseInt(kaMatch[2]) / 100,
                explanation: kaMatch[3].trim(),
                weight: parseFloat(kaMatch[4])
            });
        }
    }
    
    return items;
}

/**
 * 逐项分析未得满分的评分项，判断是否与 Skill 定义相关
 */
export async function analyzeEvaluationItems(
    skillDef: string,
    judgmentReason: string,
    userQuery: string,
    actualAnswer: string,
    conversationHistory: string,
    user?: string | null
): Promise<SkillImprovementItem[]> {
    console.log(`[ItemAttribution] Starting analysis...`);
    const { client, model } = await getLlmClient(user);
    if (!client || !skillDef || !judgmentReason) {
        console.warn(`[ItemAttribution] ✗ Early return: client=${client ? 'present' : 'absent'}, skillDef=${skillDef ? 'present' : 'absent'}, judgmentReason=${judgmentReason ? 'present' : 'absent'}`);
        return [];
    }
    
    // 1. 解析评分项
    const items = parseEvaluationItemsFromReason(judgmentReason);
    console.log(`[ItemAttribution] Parsed ${items.length} evaluation items from judgment reason`);
    
    // 2. 筛选未得满分的项目 (match_score < 1.0)
    const imperfectItems = items.filter(item => item.match_score < 1.0);
    console.log(`[ItemAttribution] ${imperfectItems.length} items need analysis (score < 100%)`);
    
    if (imperfectItems.length === 0) {
        console.log(`[ItemAttribution] ✗ No imperfect items found, returning empty array`);
        return [];
    }
    
    // 3. 逐项分析
    const { generateSkillIssuePrompt } = require('@/prompts/item-attribution-prompt');
    const results: SkillImprovementItem[] = [];
    
    for (const item of imperfectItems) {
        try {
            const prompt = generateSkillIssuePrompt(skillDef, item, userQuery, actualAnswer, conversationHistory);
            
            const response = await withTimeout(
                (options) => client.chat.completions.create(
                    {
                        messages: [{ role: "user", content: prompt }],
                        model: model,
                    },
                    options
                ),
                'Skill issue analysis API',
            );
            
            const content = response.choices?.[0]?.message?.content;
            if (!content) {
                console.error(`\n[SkillAnalysis API Error 🚨] LLM content is empty for item: ${item.id}`);
                console.error(">>> Full LLM Response:");
                console.error(JSON.stringify(response, null, 2));
                console.error("<<<\n");
                continue;
            }
            
            appendLog('skill_issue_analysis', { item_id: item.id, prompt }, { raw_output: content });
            
            let jsonStr = content.trim();
            const matchParse = jsonStr.match(/```(?:json)?\\s*([\\s\\S]*?)\\s*```/i);
            if (matchParse) {
                jsonStr = matchParse[1];
            } else {
                const first = jsonStr.indexOf('{');
                const last = jsonStr.lastIndexOf('}');
                if (first !== -1 && last !== -1 && last >= first) {
                    jsonStr = jsonStr.substring(first, last + 1);
                }
            }
            const parsed = JSON.parse(jsonStr);
            
            // 只添加确定是 Skill 问题的项目
            if (parsed.is_skill_issue === true) {
                results.push({
                    ...item,
                    is_skill_issue: true,
                    reasoning: parsed.reasoning ?? '',
                    improvement_suggestion: parsed.improvement_suggestion
                });
                console.log(`[SkillAnalysis] ${item.id}: IS Skill Issue - ${parsed.reasoning?.substring(0, 50)}...`);
            } else {
                console.log(`[SkillAnalysis] ${item.id}: NOT Skill Issue - ${parsed.reasoning?.substring(0, 50)}...`);
            }
            
        } catch (e: any) {
            console.error(`[SkillAnalysis] Error analyzing ${item.id}:`, e.message);
            appendLog('skill_issue_analysis_error', { item_id: item.id }, { error: e.message });
        }
    }
    
    // 只返回 Skill 问题的项目
    return results;
}

export async function analyzeFailures(
    input: any[], 
    skillName?: string, 
    skillDef?: string, 
    answerScore?: number, 
    judgmentReason?: string,
    userQuery?: string,
    actualAnswer?: string,
    user?: string | null
): Promise<FailureAnalysisResult> {
    const messages = normalizeInteractions(input);
    const faultPathSteps = buildFaultPathSteps(input, 'zh');
    if (!messages || messages.length === 0) {
        return { failures: [] };
    }

    try {
        const { client, model } = await getLlmClient(user);
        if (!client || !client.apiKey) {
            console.warn("LLM Analysis disabled. Skipping.");
            return { failures: [], skill_issues: [] };
        }
        // Construct conversation history string
        let history = "";

        // User Suggestion: Just take the LAST interaction's requestMessages + responseMessage.
        // This assumes the agent framework (OpenHands/Witty) sends the full accrued history in the final request.
        const lastInteraction = messages[messages.length - 1];
        
        const reqMsgs = lastInteraction.requestMessages || [];
        reqMsgs.forEach((m: any) => {
             let content = "";
             if (typeof m.content === 'string') content = m.content;
             else if (Array.isArray(m.content)) content = JSON.stringify(m.content);
             history += `[${(m.role || 'UNKNOWN').toUpperCase()}]: ${content}\n`;
        });

        const resMsg = lastInteraction.responseMessage;
        if (resMsg) {
             let content = "";
             if (typeof resMsg.content === 'string') content = resMsg.content;
             else if (Array.isArray(resMsg.content)) content = JSON.stringify(resMsg.content);
             history += `[ASSISTANT]: ${content}\n`;
        } else if (lastInteraction.debug_raw_stream) {
             history += `[SYSTEM/TOOL OUTPUTS]: (Check raw logs for full details)\n`;
        }

        const { generateFailureAnalysisPrompt } = require('@/prompts/failure-analysis-prompt');
        const stepCandidates = faultPathSteps.map(formatFaultPathStepForPrompt).join('\n');
        const prompt = generateFailureAnalysisPrompt(history, stepCandidates);

        const response = await withTimeout(
            (options) => client.chat.completions.create(
                {
                    messages: [{ role: "user", content: prompt }],
                    model: model,
                },
                options
            ),
            'Failure analysis API',
        );

        const content = response.choices?.[0]?.message?.content;
        
        if (!content) {
            console.error("\n[Failure Analysis API Error 🚨] LLM content is empty!");
            console.error(">>> Full LLM Response:");
            console.error(JSON.stringify(response, null, 2));
            console.error("<<<\n");
            return { failures: [] };
        }

        appendLog('failure_analysis', { prompt, history_length: history.length }, { raw_output: content });

        let jsonStr = content.trim();
        const matchParse = jsonStr.match(/```(?:json)?\\s*([\\s\\S]*?)\\s*```/i);
        if (matchParse) {
            jsonStr = matchParse[1];
        } else {
            const first = jsonStr.indexOf('{');
            const last = jsonStr.lastIndexOf('}');
            if (first !== -1 && last !== -1 && last >= first) {
                jsonStr = jsonStr.substring(first, last + 1);
            }
        }
        const result = JSON.parse(jsonStr);
        const failures: FailureItem[] = attachFailureAnchors(result.failures || [], faultPathSteps, 'zh');
        
        // 用于存储 Skill 问题分析结果
        let skillIssues: SkillImprovementItem[] = [];

        // --- Skill Analysis Step ---
        console.log(`[SkillAnalysis] Checking: skillName=${skillName || 'none'}, skillDef=${skillDef ? 'present' : 'absent'}, failuresCount=${failures.length}, answerScore=${answerScore}`);
        
        if (skillName && skillDef) {
            console.log(`[SkillAnalysis] ✓ Skill name and definition found`);
            // 【Skill 问题分析】如果分数 < 1.0，对未得满分的评分项逐项分析是否是 Skill 问题
            // 注意：actualAnswer 可能为空（旧数据），此时使用 history 作为替代
            const effectiveAnswer = actualAnswer || "(见交互历史)";
            const effectiveQuery = userQuery || "(未知)";
            
            console.log(`[SkillAnalysis] Conditions check: answerScore=${answerScore}, judgmentReason=${judgmentReason ? 'present' : 'absent'}, history=${history ? 'present' : 'absent'}`);
            
            if (answerScore !== undefined && answerScore < 1.0 && judgmentReason && history) {
                console.log(`[SkillAnalysis] ✓ All conditions met. Score is imperfect (${answerScore}). Analyzing which items are Skill issues...`);
                console.log(`[SkillAnalysis] Using: query=${effectiveQuery.substring(0, 50)}..., answer=${effectiveAnswer.substring(0, 50)}..., history_len=${history.length}`);
                
                skillIssues = await analyzeEvaluationItems(
                    skillDef,
                    judgmentReason,
                    effectiveQuery,
                    effectiveAnswer,
                    history,  // 完整交互历史（这是最重要的分析材料）
                    user
                );
                
                console.log(`[SkillAnalysis] Analysis complete: ${skillIssues.length} items identified as Skill issues`);
            } else if (answerScore !== undefined && answerScore >= 1.0) {
                 console.log(`[SkillAnalysis] ✗ Skipped: Perfect score (${answerScore}). No Skill analysis needed.`);
            } else {
                console.log(`[SkillAnalysis] ✗ Skipped: Conditions not met - answerScore=${answerScore}, judgmentReason=${judgmentReason ? 'present' : 'absent'}, history=${history ? 'present' : 'absent'}`);
            }
        } else {
            console.warn(`[SkillAnalysis] ✗ Skipped: Missing skillName (${skillName || 'none'}) or skillDef (${skillDef ? 'present' : 'absent'})`);
        }

        return { 
            failures,
            skill_issues: skillIssues.length > 0 ? skillIssues : undefined
        };

    } catch (error) {
        console.error("Failure Analysis Error:", error);
        return { failures: [] };
    }
}



// Helper to extract query rules-based (from accumulated history in last request)
function extractQueryRuleBased(lastRequestMessages: any[]): string {
    if (!lastRequestMessages || lastRequestMessages.length === 0) return "";
    
    // Rule: "From the content of the first user message found in the history"
    const userMsg = lastRequestMessages.find((m: any) => m.role === 'user');
    if (userMsg) {
            const content = userMsg.content;
            if (typeof content === 'string') return content;
            if (Array.isArray(content)) {
                // Filter out known system injections (e.g. <system-reminder>)
                const validParts = content.filter((c:any) => 
                    c.type === 'text' && 
                    !c.text.trim().startsWith('<system-reminder>')
                );
                
                if (validParts.length > 0) {
                     return validParts.map((p:any) => p.text).join('\n').trim();
                }

                // Fallback: if all filtered out, return the last text part (maybe user wrapped it?) 
                // or just return the original find result if we were desperate, but let's stick to validParts
                const textPart = content.find((c:any) => c.type === 'text');
                if (textPart) return textPart.text;
            }
    }
    return "";
}

// Helper to extract final result rules-based
function extractFinalResultRuleBased(lastResponseMessage: any): string {
    if (!lastResponseMessage) return "";

    // Rule: "From the content of the last assistant message (which is the response)"
    const content = lastResponseMessage.content;
    if (content && typeof content === 'string') return content;
    return "";
}

// Helper to extract skill rules-based
function extractSkillRuleBased(lastRequestMessages: any[], lastResponseMessage: any): string {
    let allText = "";
    
    // Add history from last request
    if (lastRequestMessages) {
        lastRequestMessages.forEach((m: any) => {
            if (typeof m.content === 'string') allText += m.content + "\n";
        });
    }
    // Add final response
    if (lastResponseMessage && typeof lastResponseMessage.content === 'string') {
        allText += lastResponseMessage.content + "\n";
    }

    // Regex patterns for skill loading
    // Pattern 1: "Loading skill:? [name]"
    const loadMatch = allText.match(/(?:Loading skill|Load skill)[:\s]+([a-zA-Z0-9_\-\.]+)/i);
    if (loadMatch && loadMatch[1]) {
        return loadMatch[1].trim();
    }
    
    // Pattern 2: "Skill [name] loaded"
    const loadedMatch = allText.match(/Skill\s+([a-zA-Z0-9_\-\.]+)\s+loaded/i);
    if (loadedMatch && loadedMatch[1]) {
         return loadedMatch[1].trim();
    }
    
    return "";
}

// Helper to check if string is JSON
function isJsonString(str: string) {
    if (!str || typeof str !== 'string') return false;
    try {
        const o = JSON.parse(str);
        if (o && typeof o === "object") {
            return true;
        }
    } catch (e) { }
    return false;
}

/**
 * Normalizes a list of messages (which could be flat messages OR an array of interactions)
 * into a consistent array of Interaction-like objects.
 */
export function normalizeInteractions(messages: any[]): any[] {
    return normalizeInteractionsCore(messages);
}


export async function analyzeSession(input: any[], user?: string | null): Promise<AnalysisResult> {
    const messages = normalizeInteractions(input);
    if (!messages || messages.length === 0) {
        return { query: "", skill: "", final_result: "" };
    }

    let query = "";
    let final_result = "";
    let skill = "";

    // 1. Extract Query: Find first meaningful user message
    for (const interaction of messages) {
        const reqMsgs = interaction.requestMessages || [];
        // Sort of standard OpenAI: System usually first, then User.
        // We find the first 'user' message in the request.
        const userMsg = reqMsgs.find((m: any) => m.role === 'user');
        
        if (userMsg) {
            let contentText = "";
            if (typeof userMsg.content === 'string') {
                contentText = userMsg.content;
            } else if (Array.isArray(userMsg.content)) {
                // ... (keep existing filtering logic)
                const validParts = userMsg.content.filter((c:any) => 
                    c.type === 'text' && 
                    !c.text.trim().startsWith('<system-reminder>') &&
                    !c.text.includes('[SUGGESTION MODE:') 
                );
                if (validParts.length > 0) {
                    contentText = validParts.map((p:any) => p.text).join('\n').trim();
                }
            }

            if (contentText) {
               // OpenHands specific cleaning
               contentText = contentText.replace(/<EXTRA_INFO>[\s\S]*?<\/EXTRA_INFO>/g, "");
               
               const trimmed = contentText.trim();
               // Filter out common automated/health-check strings
               if (trimmed === 'count' || trimmed === 'ping') continue;
               // Filter out title generation prompts
               if (trimmed.startsWith('Please write a 5-10 word title')) continue;
               // NEW: Filter out Opencode health checks or similar if identified
               if (trimmed === 'hi' || trimmed === 'hello' && messages.length > 2) continue; // heuristic

               if (!query) {
                   query = trimmed;
                   // console.log(`[Judge] Query extracted: ${query.substring(0, 50)}...`);
               }
               if (query) break; 
            }
        }
    }

    // 2. Extract Final Result: Iterate BACKWARDS
    for (let i = messages.length - 1; i >= 0; i--) {
        const interaction = messages[i];
        
        // Skip interactions triggered by Suggestion Mode or System Reminders that aren't real user tasks
        const hasSuggestionRequest = (interaction.requestMessages || []).some((m: any) => {
             if (typeof m.content === 'string') return m.content.includes('[SUGGESTION MODE:');
             if (Array.isArray(m.content)) return m.content.some((c:any) => c.text && c.text.includes('[SUGGESTION MODE:'));
             return false;
        });
        if (hasSuggestionRequest) continue;

        const resMsg = interaction.responseMessage;
        
        // Reconstruct content from debug_raw_stream if main content is empty

        // Reconstruct content from debug_raw_stream if main content is empty
        let contentText = "";
        
        if (resMsg && resMsg.content && typeof resMsg.content === 'string') {
            contentText = resMsg.content;
        } else if (resMsg && Array.isArray(resMsg.content)) {
             const textPart = resMsg.content.find((c:any) => c.type === 'text');
             if (textPart) contentText = textPart.text;
        }

        // Fallback to raw stream if empty
        if ((!contentText || contentText.trim() === "") && interaction.debug_raw_stream) {
             try {
                // Reassemble text from stream
                let assembled = "";
                for (const chunk of interaction.debug_raw_stream) {
                     if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content) {
                         assembled += chunk.choices[0].delta.content;
                     }
                     if (chunk.type === 'content_block_delta' && chunk.delta && chunk.delta.type === 'text_delta') {
                         assembled += chunk.delta.text;
                     }
                }
                if (assembled) contentText = assembled;
             } catch(e) {}
        }

        // --- NEW LOGIC: Accumulate preceding assistant messages ---
        const contentCandidates: string[] = [];
        let stopBacktracking = false; // Flag to stop outer loop if needed (though we only process last interaction logic currently)

        // 1. Check preceding assistant messages in requestMessages
        if (interaction.requestMessages && interaction.requestMessages.length > 0) {
             for (let j = interaction.requestMessages.length - 1; j >= 0; j--) {
                 const msg = interaction.requestMessages[j];
                 // We only concatenate continuous block of assistant messages
                 if (msg.role === 'assistant') {
                      let msgContent = "";
                      if (typeof msg.content === 'string') msgContent = msg.content;
                      else if (Array.isArray(msg.content)) {
                          const textPart = msg.content.find((c:any) => c.type === 'text');
                          if (textPart) msgContent = textPart.text;
                      }

                      if (msgContent && msgContent.trim()) {
                           const trimmed = msgContent.trim();
                           if (!isJsonString(trimmed)) {
                               contentCandidates.unshift(trimmed);
                               
                               // HEURISTIC: Stop if Header found
                               // This prevents grabbing previous "noise" messages if the answer starts with a structural header here.
                               if (trimmed.startsWith('#') || trimmed.startsWith('##') || trimmed.startsWith('###')) {
                                   stopBacktracking = true;
                                   break;
                               }
                           }
                      } else {
                           // Stop if we hit an assistant message with no content (pure tool call)
                           // This separate the final contiguous text block from previous execution steps
                           break;
                      }
                 } else {
                     // Stop at non-assistant message
                     break;
                 }
             }
        }

        // 2. Add the response message content
        if (contentText && contentText.trim()) {
             const trimmed = contentText.trim();
             // Ignore if JSON (likely title generation or control)
             if (!isJsonString(trimmed)) {
                 contentCandidates.push(trimmed);
                 
                 // HEURISTIC: Check if this block itself starts with a Header (e.g. single message report)
                  if (trimmed.startsWith('#') || trimmed.startsWith('##') || trimmed.startsWith('###')) {
                      // If the response itself is the start of the report, we don't need to look back at requestMessages?
                      // Wait, we ALREADY looked back above.
                      // If `contentCandidates` has items from requestMessages, and we push this,
                      // we effectively appended. 
                      // If the *Response* starts with Header, it implies it might be the start *unless* previous messages were also part of it.
                      // But usually if Response starts with Header, it's a new section.
                      // However, we already processed requestMessages. 
                      // If requestMessages resulted in content, and then Response starts with Header...
                      // E.g. Request: "Here is report:" (No header)
                      // Response: "## Analysis" (Header)
                      // Result: "Here is report:\n\n## Analysis". This is fine.
                      //
                      // The heuristic is mainly to STOP going further BACK.
                      // Since we are at the end of the chain for this interaction, there's nowhere further back in *this* interaction.
                      // So we don't need to set stopBacktracking here for *this* interaction loop context.
                  }
             }
        }

        if (contentCandidates.length > 0) {
            final_result = contentCandidates.join('\n\n');
            break;
        }


    }

    // 3. Extract Skill: Scan ALL interactions
    const foundSkills = new Set<string>();
    let allTextForSkill = "";

    for (const interaction of messages) {
         // Check Request
         const reqMsgs = interaction.requestMessages || [];
         reqMsgs.forEach((m:any) => {
             if (typeof m.content === 'string') allTextForSkill += m.content + "\n";
             else if (Array.isArray(m.content)) {
                 m.content.forEach((c:any) => {
                     if (c.type === 'text') allTextForSkill += c.text + "\n";
                 });
             }
         });
         // Check Response
         const resMsg = interaction.responseMessage;
         if (resMsg) {
             if (typeof resMsg.content === 'string') allTextForSkill += resMsg.content + "\n";
             else if (Array.isArray(resMsg.content)) {
                 resMsg.content.forEach((c:any) => {
                     if (c.type === 'text') allTextForSkill += c.text + "\n";
                 });
             }

             // Check for structured tool calls
             if (resMsg.tool_calls && Array.isArray(resMsg.tool_calls)) {
                 resMsg.tool_calls.forEach((tc: any) => {
                     const toolName = tc.function?.name ?? tc.name;
                     if (toolName) {
                         if (toolName === 'skill' || toolName === 'load_skill') {
                             try {
                                 const rawArgs = tc.function?.arguments ?? tc.arguments;
                                 const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
                                 const skillName = args?.name ?? args?.skill_name ?? args?.skillName ?? args?.skill;
                                 if (skillName) foundSkills.add(skillName);
                             } catch(e) {}
                         } else {
                             foundSkills.add(toolName);
                         }
                     }
                 });
             }
             if (resMsg.function_call && resMsg.function_call.name) {
                 foundSkills.add(resMsg.function_call.name);
             }
         }
    }
    
    // Regex patterns for skill loading (Same as before)
    const loadMatch = allTextForSkill.match(/(?:Loading skill|Load skill)[:\s]+([a-zA-Z0-9_\-\.]+)/i);
    if (loadMatch && loadMatch[1]) {
        foundSkills.add(loadMatch[1].trim());
    }
    
    const loadedMatch = allTextForSkill.match(/Skill\s+([a-zA-Z0-9_\-\.]+)\s+loaded/i);
    if (loadedMatch && loadedMatch[1]) {
        foundSkills.add(loadedMatch[1].trim());
    }

    // Prefer explicit "Loading skill" pattern if found? Or just join all?
    // If we found "Loading skill: foo", use that.
    // If not, use tool names.
    // But Opencode might use `load_skill` tool?
    // If tool name is `load_skill`, we might want to look at arguments.
    // simpler approach: join all found skills or pick the first non-generic one?
    // For now, let's join them if multiples, or pick the first one.
    
    if (foundSkills.size > 0) {
        // Filter out common generic tools if necessary, but for now take all
        skill = Array.from(foundSkills).join(', ');
    }

    console.log(`[Rule-Based Analysis] Query: ${query.substring(0,20)}..., Skill: ${skill}, Result Length: ${final_result.length}`);

    appendLog('extraction', { 
       messages_summary: `Total ${messages.length} interactions`,
       notes: "Scanned full history"
    }, { query, skill, final_result });


    // Extract Result using LLM if possible
    let llmExtractedResult = "";
    try {
         // Should we use 'user' context? 
         // analyzeSession signature doesn't currently accept 'user'.
         // We might need to guess or pass 'null' if we don't change the signature everywhere.
         // Let's check callers. 'src/app/api/end/route.ts' calls it.
         // For now, let's try to get client with null user (default config) or modify signature.
         
         const { client, model } = await getLlmClient(user); // Use default config if user not passed
         if (client && client.apiKey) {
             // Construct History for LLM
             let history = "";
             messages.forEach((interaction: any) => {
                 const reqMsgs = interaction.requestMessages || [];
                 reqMsgs.forEach((m: any) => {
                      let content = "";
                      if (typeof m.content === 'string') content = m.content;
                      else if (Array.isArray(m.content)) {
                          const textPart = m.content.find((c:any) => c.type === 'text');
                          if (textPart) content = textPart.text;
                      }
                      history += `[${(m.role || 'UNKNOWN').toUpperCase()}]: ${content}\n`;
                 });

                 const resMsg = interaction.responseMessage;
                 if (resMsg) {
                      let content = "";
                      if (typeof resMsg.content === 'string') content = resMsg.content;
                      else if (Array.isArray(resMsg.content)) {
                          const textPart = resMsg.content.find((c:any) => c.type === 'text');
                          if (textPart) content = textPart.text;
                      }
                      history += `[ASSISTANT]: ${content}\n`;
                 }
             });

             const { generateExtractionPrompt } = require('@/prompts/extraction-prompt');
             const prompt = generateExtractionPrompt(history);

             const response = await withTimeout(
                 (options) => client.chat.completions.create(
                     {
                         messages: [{ role: "user", content: prompt }],
                         model: model,
                         temperature: 0.1
                     },
                     options
                 ),
                 'Session extraction API',
             );

             const content = response.choices[0].message.content;
             if (content) {
                 llmExtractedResult = content.trim();
                 appendLog('result_extraction_llm', { history_length: history.length }, { extracted: llmExtractedResult });
             }
         }
    } catch (e) {
        console.error("LLM Extraction Failed", e);
    }

    // Use LLM result if available and valid length, otherwise fallback to Rule-Based
    if (llmExtractedResult && llmExtractedResult.length > 20) {
        console.log(`[Judge] LLM extraction preferred (Length: ${llmExtractedResult.length} vs Rule: ${final_result.length})`);
        final_result = llmExtractedResult;
    } else if (final_result) {
        console.log(`[Judge] Rule-Based extraction used (Length: ${final_result.length})`);
    }

    return {
        query,
        skill,
        final_result
    };

}
