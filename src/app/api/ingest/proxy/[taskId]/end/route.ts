
import { readConfig, saveExecutionRecord, findBestMatchConfig } from '@/lib/storage/data-service';
import { analyzeExecutionMatch, analyzeDynamicOnly } from '@/lib/engine/observability/flow-parser';
import { analyzeFailures, analyzeSession, judgeAnswer } from '@/lib/engine/evaluation/judge';
import { isEvaluatorTraceRecord } from '@/lib/evaluator-agent';
import { db, prisma } from '@/lib/storage/prisma';
import { endSession } from '@/lib/ingest/proxy-store';
import { getActiveConfig } from '@/lib/storage/server-config';
import { NextResponse } from 'next/server';

import { SKILLS_EXTRACT_PROMPT } from '@/prompts/skills-prompt';

const SKILLS_EXTRACT_QUERY = SKILLS_EXTRACT_PROMPT;

function getBaseUrl(taskId: string): string {
  if (taskId.startsWith('claude')) return 'https://api.deepseek.com/anthropic';
  return 'https://api.deepseek.com';
}

function parseSkillsFromModelResponse(content: string): string[] {
  if (!content || typeof content !== 'string') return [];
  const raw = content.trim();
  const cleaned = raw.replace(/^```\w*\n?|```\s*$/g, '').trim();
  let list: string[] = [];
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) list = parsed;
    else if (parsed && Array.isArray(parsed.skills)) list = parsed.skills;
    else if (parsed && typeof parsed.skills === 'string') list = [parsed.skills];
  } catch {
    list = cleaned.split(/\n+/).map((s) => s.replace(/^[\s\-*•\d.)]+|[\s\-*•]+$/g, '').trim());
  }
  const normalized = list
    .filter((s) => s != null && String(s).trim() !== '')
    .map((s) => String(s).trim().replace(/^['"]+|['"]+$/g, ''));
  const skillNamePattern = /^[a-zA-Z0-9_\-\.]+$/;
  return normalized.filter((s) => skillNamePattern.test(s));
}

const SKILLS_FETCH_TIMEOUT_MS = 25_000;

interface InvokedSkill {
  name: string;
  version: number | null;
}

function extractSkillsWithVersionsFromWittySession(session: {
  interactions: { toolCalls?: any[]; responseMessage?: { tool_calls?: any[] } }[];
}): InvokedSkill[] {
  const seen = new Set<string>();
  const skills: InvokedSkill[] = [];
  const skillNamePattern = /^[a-zA-Z0-9_\-\.]+$/;

  for (const interaction of session.interactions) {
    const calls =
      interaction.toolCalls ??
      interaction.responseMessage?.tool_calls ??
      [];
    for (const tc of calls) {
      const name = tc?.function?.name ?? tc?.name;
      if (name !== 'load_skill') continue;
      const raw = tc?.function?.arguments ?? tc?.arguments ?? '';
      if (!raw || typeof raw !== 'string') continue;
      try {
        const args = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const skillName = args?.skill_name ?? args?.skillName ?? args?.name;
        if (skillName != null && String(skillName).trim()) {
          const s = String(skillName).trim().replace(/^['"]+|['"]+$/g, '');
          if (skillNamePattern.test(s) && !seen.has(s)) {
            seen.add(s);
            const version = args?.version != null ? Number(args.version) : null;
            skills.push({ name: s, version: (version !== null && !isNaN(version)) ? version : null });
          }
        }
      } catch {
      }
    }
  }
  return skills;
}

function extractSkillsWithVersionsFromOpencodeSession(session: {
  interactions: { toolCalls?: any[]; responseMessage?: { tool_calls?: any[] } }[];
}): InvokedSkill[] {
  const seen = new Set<string>();
  const skills: InvokedSkill[] = [];
  const skillNamePattern = /^[a-zA-Z0-9_\-\.]+$/;

  for (const interaction of session.interactions) {
    const calls =
      interaction.toolCalls ??
      interaction.responseMessage?.tool_calls ??
      [];
    for (const tc of calls) {
      const name = tc?.function?.name ?? tc?.name;
      if (name !== 'skill') continue;
      const raw = tc?.function?.arguments ?? tc?.arguments ?? '';
      if (!raw || typeof raw !== 'string') continue;
      try {
        const args = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const skillName = args?.name ?? args?.skill_name ?? args?.skillName ?? args?.skill;
        if (skillName != null && String(skillName).trim()) {
          const s = String(skillName).trim().replace(/^['"]+|['"]+$/g, '');
          if (skillNamePattern.test(s) && !seen.has(s)) {
            seen.add(s);
            const version = args?.version != null ? Number(args.version) : null;
            skills.push({ name: s, version: (version !== null && !isNaN(version)) ? version : null });
          }
        }
      } catch {
      }
    }
  }
  return skills;
}

function collectSkillToolUseFromContent(
  content: unknown,
  seen: Set<string>,
  skills: InvokedSkill[]
): void {
  if (!content || !Array.isArray(content)) return;
  const skillNamePattern = /^[a-zA-Z0-9_\-\.]+$/;
  for (const block of content) {
    if (block?.type !== 'tool_use' || block?.name !== 'Skill') continue;
    const input = block.input;
    const skillName = input?.skill ?? input?.skill_name ?? input?.skillName ?? input?.name;
    if (skillName == null || !String(skillName).trim()) continue;
    const s = String(skillName).trim().replace(/^['"]+|['"]+$/g, '');
    if (skillNamePattern.test(s) && !seen.has(s)) {
      seen.add(s);
      const version = input?.version != null ? Number(input.version) : null;
      skills.push({ name: s, version: (version !== null && !isNaN(version)) ? version : null });
    }
  }
}

function extractSkillsWithVersionsFromClaudeSession(session: {
  interactions: {
    requestMessages?: { role?: string; content?: unknown }[];
    responseMessage?: { content?: unknown };
  }[];
}): InvokedSkill[] {
  const seen = new Set<string>();
  const skills: InvokedSkill[] = [];

  for (const interaction of session.interactions) {
    collectSkillToolUseFromContent(interaction.responseMessage?.content, seen, skills);
    const reqMsgs = interaction.requestMessages ?? [];
    for (const msg of reqMsgs) {
      if (msg?.role !== 'assistant') continue;
      collectSkillToolUseFromContent(msg.content, seen, skills);
    }
  }
  return skills;
}

function messageContentToText(msg: { content?: string | { type?: string; text?: string }[] }): string {
  if (!msg?.content) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (!Array.isArray(msg.content)) return '';
  return msg.content
    .filter((c: any) => c?.type === 'text' && c?.text)
    .map((c: any) => c.text)
    .join('\n')
    .trim();
}

async function fetchSkillsViaModel(
  taskId: string,
  interactions: { requestMessages: any[]; responseMessage: any }[]
): Promise<string[]> {
  if (!interactions.length) return [];

  const history: { role: 'user' | 'assistant' | 'system'; content: string }[] = [];
  for (const interaction of interactions) {
    const reqMsgs = interaction.requestMessages || [];
    const userParts: string[] = [];
    for (const m of reqMsgs) {
      if (m.role !== 'user') continue;
      const text = messageContentToText(m);
      if (text && !text.startsWith('<system-reminder>') && !text.includes('[SUGGESTION MODE:')) {
        userParts.push(text);
      }
    }
    if (userParts.length) {
      history.push({ role: 'user', content: userParts.join('\n\n') });
    }
    const resMsg = interaction.responseMessage;
    if (resMsg?.content) {
      const assistantText = messageContentToText(resMsg);
      if (assistantText) {
        history.push({ role: 'assistant', content: assistantText });
      }
    }
  }

  const maxTurns = 30;
  const trimmedHistory =
    history.length > maxTurns ? history.slice(-maxTurns) : history;
  const messages = [...trimmedHistory, { role: 'user' as const, content: SKILLS_EXTRACT_QUERY }];

  const baseUrl = getBaseUrl(taskId);
  const chatUrl = `${baseUrl}/v1/chat/completions`;

  const activeConfig = await getActiveConfig();
  const apiKey = activeConfig?.apiKey;
  if (!apiKey) {
    console.warn('No model API Key configured in Settings, skipping skills extraction via model.');
    return [];
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SKILLS_FETCH_TIMEOUT_MS);

  try {
    const body: Record<string, unknown> = {
      model: baseUrl.includes('anthropic') ? 'claude-sonnet-4-20250514' : 'deepseek-chat',
      max_tokens: 1024,
      stream: false,
      messages,
    };
    const res = await fetch(chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      const err = await res.text();
      console.error('Skills extraction error', res.status, err);
      return [];
    }
    const data = await res.json();
    const content =
      data.choices?.[0]?.message?.content ??
      data.content?.find((c: any) => c.type === 'text')?.text ??
      data.content?.[0]?.text ??
      '';
    return parseSkillsFromModelResponse(String(content));
  } catch (e) {
    clearTimeout(timeoutId);
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('abort')) {
      console.warn('fetchSkillsViaModel timeout, skipping skills');
    } else {
      console.error('fetchSkillsViaModel error', e);
    }
    return [];
  }
}

export const maxDuration = 60;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ taskId: string }> }
) {
  try {
    const taskId = (await params).taskId;
    const session = await endSession(taskId);

    if (!session) {
      return NextResponse.json({ error: 'Session not found or empty' }, { status: 404 });
    }

    const endTime = Date.now();
    const duration = (endTime - session.startTime) / 1000;

    let totalTokens = 0;
    let totalReasoningTokens = 0;
    for (const interaction of session.interactions) {
      const usage = interaction.usage || interaction.responseMessage?.usage;
      if (usage) {
         let parsedUsage = usage;
        if (typeof usage === 'string') {
             try { parsedUsage = JSON.parse(usage); } catch(e) {
                 console.warn(`[ProxyEnd] Failed to parse usage JSON for task ${taskId}:`, e);
             }
        }

        const anyUsage = parsedUsage as any;
        const t = (anyUsage.total_tokens || anyUsage.total || 0);
        const r = (anyUsage.reasoning || anyUsage.reasoning_tokens || anyUsage.completion_tokens_details?.reasoning_tokens || 0);

        totalTokens += Number(t);
        totalReasoningTokens += Number(r);
      }
    }

    let framework = taskId.split('-')[0] || 'unknown';
    if (framework === 'claude') framework = 'claudecode';

    const analysis = await analyzeSession(session.interactions, session.user);
    
    if (!session.query && analysis.query) {
        try {
            await db.updateSession(taskId, { query: analysis.query });
            console.log(`[End] Updated session query for ${taskId}: ${analysis.query.substring(0, 50)}...`);
        } catch (e) {
            console.warn(`[End] Failed to update session query: ${e}`);
        }
    }

    const isWittyLike =
      framework === 'deepagent(langgraph)' ||
      framework === 'witty' ||
      framework === 'witty(deepagents)';
    let skillsWithVersions: InvokedSkill[];
    if (framework === 'claude') {
      skillsWithVersions = extractSkillsWithVersionsFromClaudeSession(session);
      if (skillsWithVersions.length === 0) {
        console.log(`No Skill tool_use in Claude session for ${taskId}, falling back to model extraction...`);
        const fallbackSkills = await fetchSkillsViaModel(taskId, session.interactions);
        skillsWithVersions = fallbackSkills.map(name => ({ name, version: null }));
      }
      console.log(`Skills from Claude session for ${taskId}:`, JSON.stringify(skillsWithVersions));
    } else if (framework === 'opencode') {
      skillsWithVersions = extractSkillsWithVersionsFromOpencodeSession(session);
      console.log(`Skills from OpenEncode session for ${taskId}:`, JSON.stringify(skillsWithVersions));
    } else if (isWittyLike) {
      skillsWithVersions = extractSkillsWithVersionsFromWittySession(session);
      console.log(`Skills from Witty session for ${taskId}:`, JSON.stringify(skillsWithVersions));
    } else {
      console.log(`Fetching skills via model for ${taskId}...`);
      const modelSkills = await fetchSkillsViaModel(taskId, session.interactions);
      skillsWithVersions = modelSkills.map(name => ({ name, version: null }));
      console.log(`Skills from model for ${taskId}:`, JSON.stringify(skillsWithVersions));
    }

    const primarySkillName = skillsWithVersions.length > 0 ? skillsWithVersions[0].name : undefined;
    const primarySkillVersion = skillsWithVersions.length > 0 ? skillsWithVersions[0].version : null;

    let skillDef = undefined;
    let skillVersion = null;
    console.log(`[End] Primary skill name for ${taskId}: ${primarySkillName || '(none)'}`);
    if (primarySkillName) {
         const skillRecord = await db.findSkill(primarySkillName, session.user || null);
         if (skillRecord && skillRecord.versions && skillRecord.versions.length > 0) {
             const targetVersion = skillRecord.activeVersion || 0;
             const sv = skillRecord.versions.find((v: any) => v.version === targetVersion);
             if (sv && sv.content) {
                 skillDef = sv.content;
                 skillVersion = sv.version;
                 console.log(`[End] Skill definition found for ${primarySkillName} v${skillVersion}, length: ${skillDef?.length || 0}`);
             } else {
                 skillDef = skillRecord.versions[0].content;
                 skillVersion = skillRecord.versions[0].version;
                 console.log(`[End] Using fallback version ${skillVersion} for ${primarySkillName}, length: ${skillDef?.length || 0}`);
             }
         } else {
             console.warn(`[End] Skill definition NOT FOUND for ${primarySkillName}. Attribution will be skipped.`);
         }
    } else {
         console.warn(`[End] No primarySkillName extracted. Attribution will be skipped.`);
    }

    let evaluation = { is_skill_correct: false, is_answer_correct: false, answer_score: 0, judgment_reason: "Auto-eval skipped (missing query/result/skill)" };
    
    if (session.query) analysis.query = session.query;
    if (analysis.query) analysis.query = analysis.query.trim().replace(/^['"]+|['"]+$/g, '').trim();
    if (primarySkillName) analysis.skill = primarySkillName;

    const criteria: any = { skill_definition: skillDef };
    
    try {
        const configs = await readConfig(session.user);
        const cfg = findBestMatchConfig(configs, analysis.query, 'outcome');
        
        if (cfg) {
             criteria.root_causes = cfg.root_causes;
             criteria.key_actions = cfg.key_actions;
             criteria.standard_answer_example = cfg.standard_answer;
        }
    } catch (e) { console.warn("Config load error", e); }

    let body = {};
    try {
      body = await request.json();
    } catch (e) {}

    const skillsToSave = skillsWithVersions.length > 0 
      ? skillsWithVersions.map(s => s.name)
      : undefined;

    const result = await saveExecutionRecord({
      ...body,
      task_id: taskId,
      framework,
      query: analysis.query,
      skills: skillsToSave,
      invokedSkills: skillsWithVersions,
      skill: primarySkillName,
      skill_version: skillVersion,
      final_result: analysis.final_result,
      tokens: totalTokens,
      reasoning_tokens: totalReasoningTokens || undefined,
      latency: duration,
      timestamp: new Date(session.startTime).toISOString(),
      user: session.user,
      
      is_skill_correct: false,
      is_answer_correct: false,
      answer_score: 0,
      judgment_reason: "Evaluation in progress...",
      force_judgment: false,
      skip_evaluation: true,
    });

    const executionId = result.record?.id || result.record?.task_id || taskId;

    // --- Auto-parse execution flow ---
    if (primarySkillName && skillVersion !== null) {
        const skillRecord = await db.findSkill(primarySkillName, session.user || null);
        if (skillRecord) {
            const targetVersion = skillRecord.activeVersion || 0;
            const versionExists = (skillRecord.versions || []).some((v: any) => v.version === targetVersion);
            const effectiveVersion = versionExists ? targetVersion : (skillRecord.versions?.[0]?.version ?? null);
            
            if (effectiveVersion !== null) {
                try {
                    const matchResult = await analyzeExecutionMatch(
                        executionId,
                        skillRecord.id,
                        effectiveVersion,
                        session.user,
                        primarySkillName
                    );
                    if (matchResult.success) {
                        console.log(`[End] Auto-parsed execution flow for ${taskId} (compare mode)`);
                    } else {
                        console.warn(`[End] Auto-parse execution flow failed for ${taskId}: ${matchResult.error}`);
                    }
                } catch (e) {
                    console.warn(`[End] Auto-parse execution flow error for ${taskId}:`, e);
                }
            }
        }
    } else {
        try {
            const dynamicResult = await analyzeDynamicOnly(executionId, session.user);
            if (dynamicResult.success) {
                console.log(`[End] Auto-parsed execution flow for ${taskId} (dynamic mode)`);
            } else {
                console.warn(`[End] Auto-parse dynamic flow failed for ${taskId}: ${dynamicResult.error}`);
            }
        } catch (e) {
            console.warn(`[End] Auto-parse dynamic flow error for ${taskId}:`, e);
        }
    }

    // --- Evaluation ---
    if (analysis.query && analysis.final_result) {
        let executionSteps: { name: string; description: string; type: string }[] | null = null;
        try {
            const matchRecord = await db.findExecutionMatch(executionId);
            if (matchRecord?.extractedSteps) {
                executionSteps = typeof matchRecord.extractedSteps === 'string' 
                    ? JSON.parse(matchRecord.extractedSteps) 
                    : matchRecord.extractedSteps;
                console.log(`[End] Found ${executionSteps?.length || 0} execution steps for KA evaluation`);
            }
        } catch (e) {
            console.warn(`[End] Failed to load execution steps for KA evaluation:`, e);
        }

        const judgmentResult = await judgeAnswer(analysis.query, criteria, analysis.final_result, session.user, executionSteps);
        evaluation = {
            is_skill_correct: false,
            is_answer_correct: judgmentResult.is_correct,
            answer_score: judgmentResult.score,
            judgment_reason: judgmentResult.reason || 'Judged by Evaluation Model'
        };
    }

    const evaluatorAgentName = (body as any)?.agentName ?? (body as any)?.agent ?? null;
    const isEvaluatorTrace = isEvaluatorTraceRecord({
        agent: evaluatorAgentName,
        agentName: evaluatorAgentName,
        query: analysis.query,
        final_result: analysis.final_result,
        label: (body as any)?.label,
    });
    let failureAnalysis: { failures: any[]; skill_issues?: any[] };
    if (isEvaluatorTrace) {
        console.log(`[End] Skipping analyzeFailures for evaluator trace ${taskId} (agent=${evaluatorAgentName || 'unknown'}) — evaluator output describes evaluated case, not this session`);
        failureAnalysis = { failures: [], skill_issues: [] };
    } else {
        console.log(`[End] Calling analyzeFailures: skillName=${primarySkillName || 'none'}, skillDef=${skillDef ? 'present' : 'absent'}, answerScore=${evaluation.answer_score}`);
        failureAnalysis = await analyzeFailures(
            session.interactions,
            primarySkillName,
            skillDef,
            evaluation.answer_score,
            String(evaluation.judgment_reason || ""),
            analysis.query,
            analysis.final_result,
            session.user
        );
        console.log(`[End] analyzeFailures result: ${failureAnalysis.failures.length} failures, ${failureAnalysis.skill_issues?.length || 0} skill issues`);
    }

    // --- Update execution record with evaluation results ---
    try {
        await db.updateExecution(executionId, {
            isAnswerCorrect: evaluation.is_answer_correct,
            answerScore: evaluation.answer_score,
            judgmentReason: evaluation.judgment_reason,
            failures: JSON.stringify(failureAnalysis.failures),
            skillIssues: JSON.stringify(failureAnalysis.skill_issues || []),
        });
    } catch (e) {
        console.warn(`[End] Failed to update evaluation results for ${executionId}:`, e);
    }

    const response = NextResponse.json({
      status: 'ok',
      summary: {
        task_id: taskId,
        framework,
        duration,
        tokens: totalTokens,
        skills: skillsWithVersions,
        query_preview: analysis.query?.substring(0, 50),
      },
      upload_result: result,
    });

    console.log(`[Proxy-End] ✅ Task completed: task_id=${taskId}, framework=${framework}, score=${evaluation.answer_score}, duration=${duration.toFixed(1)}s`);
    return response;
  } catch (e) {
    console.error('[Proxy-End] ❌ Error:', e);
    const message = e instanceof Error ? e.message : 'Internal server error';
    return NextResponse.json(
      { error: 'Failed to process end signal', details: message },
      { status: 500 }
    );
  }
}
