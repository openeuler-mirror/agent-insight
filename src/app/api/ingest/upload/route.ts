import { readConfig, saveExecutionRecord, findBestMatchConfig } from '@/lib/storage/data-service';
import { isDeletedOpencodeSessionId } from '@/lib/ingest/opencode-deleted-sessions';
import { analyzeDynamicOnly } from '@/lib/engine/observability/flow-parser';
import { analyzeFailures, analyzeSession, extractSkillsFromClaudeSession, extractSkillsFromOpenClawSession, extractSkillsFromOpencodeSession, extractSkillsWithVersionsFromClaudeSession, extractSkillsWithVersionsFromOpenClawSession, extractSkillsWithVersionsFromOpencodeSession, InvokedSkill, judgeAnswer, normalizeInteractions } from '@/lib/engine/evaluation/judge';
import { isEvaluatorTraceRecord } from '@/lib/evaluator-agent';
import { db, prisma } from '@/lib/storage/prisma';
import { debounceByKey } from '@/lib/ingest/upload-analysis-debouncer';
import { getUserSettings } from '@/lib/storage/server-config';
import { assertActive, finish, startOrReplace, EvaluationCancelledError } from '@/lib/evaluation-task-manager';
import { getInternalAgentTag } from '@/lib/internal-agent-tag';
import { triggerTrajectoryAutoWatchForTask } from '@/lib/engine/evaluation/trajectory-auto-watch';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    let data;
    try {
        data = JSON.parse(rawBody);
    } catch (e) {
        console.error('JSON Parse Error:', e);
        console.error('Raw Body:', rawBody);
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const headers = request.headers;
    const apiKey = headers.get('x-witty-api-key');
    const requestOrigin = new URL(request.url).origin;

    // ─────────────────────────────────────────────────────────────────────
    // User 解析：硬拒绝原则
    // 之前这里有第 3 级"fallback 到 DB 第一个 active user"的兜底，导致一个隐性
    // 大坑——如果 client 的 .env 里 API key 配错（DB 里没这把 key），server 不
    // 报错 + 不拒收，反而把数据**静默归到一个公共账号**（例如
    // witty_insight_public@huawei.com）。运维 / 用户从 client 端完全感知不到
    // 出了什么事，UI 上看自己账号永远是空的，数据却在另一个账号下越堆越多。
    //
    // 现在的规则：
    //   1. apiKey 提供了但 DB 找不到 → 401 reject + 详细 server.log 报错
    //   2. apiKey 没提供 + payload.user 有 → 接受（向后兼容），但 warn 标记
    //      "未经鉴权" —— payload.user 不需要任何验证，谁都能伪造
    //   3. apiKey 没提供 + payload.user 也没有 → 400 reject + 报错
    // ─────────────────────────────────────────────────────────────────────
    let username: string | undefined;
    let userResolutionPath: 'api-key' | 'payload-user-unauth' | 'none' = 'none';

    if (apiKey) {
      const user = await db.findUserByApiKey(apiKey);
      if (user) {
        username = user.username;
        data.user = username;
        userResolutionPath = 'api-key';
        console.log(`[Upload-API] ✓ User resolved via API Key: ${username}`);
      } else {
        // 关键改动：之前是 console.warn 然后继续走 fallback。现在直接 401。
        // 这样 client 侧可以马上从 HTTP 401 + body 中的 detail 看到错配，而不是
        // 看到 200 OK 还以为成功了，结果数据全跑到别人账号下。
        const keyPrefix = apiKey.slice(0, 12);
        console.error(
          `[Upload-API] ❌ Rejecting upload (HTTP 401): API key not found in User table.\n` +
          `  Key prefix: ${keyPrefix}...\n` +
          `  task_id: ${data.task_id}\n` +
          `  framework: ${data.framework || 'unknown'}\n` +
          `  payload.user (untrusted): ${data.user || '(none)'}\n` +
          `  → 检查 .env 里 SKILL_INSIGHT_API_KEY 是否与 DB 中某个 User.apiKey 完全一致。\n` +
          `  → 修复方法 1：把 .env 改成 DB 里目标账号的 key\n` +
          `  → 修复方法 2：SQL UPDATE User SET apiKey='<.env 的 key>' WHERE username='<目标账号>';`
        );
        return NextResponse.json(
          {
            error: 'Invalid API key',
            detail: 'API Key 在 User 表里没匹配。Server 拒绝接收以避免数据跑到错误账号。',
            keyPrefix: keyPrefix + '...',
            hint: '检查 SKILL_INSIGHT_API_KEY env 与 server DB 里目标 User.apiKey 是否一致',
          },
          { status: 401 },
        );
      }
    }

    if (!username && data.user) {
        // 没提供 API key 时，向后兼容老 client：信任 payload.user。
        // 但 server.log 标记 "(unauth)" 让运维一眼看到"这条上报没经过鉴权"。
        // 长期建议所有 client 都升级到带 x-witty-api-key 的版本。
        username = data.user;
        userResolutionPath = 'payload-user-unauth';
        console.warn(
          `[Upload-API] ⚠ No API key, using payload.user (UNAUTHENTICATED): ${username}\n` +
          `  task_id: ${data.task_id}\n` +
          `  → client 应当配置 x-witty-api-key header 才能安全标识身份。`
        );
    }

    if (!username) {
        // 既没 apiKey 也没 payload.user —— 之前会兜底到"public"账号，现在直接拒绝。
        // 这就是用户被踩坑的那个静默路径。
        console.error(
          `[Upload-API] ❌ Rejecting upload (HTTP 400): no x-witty-api-key header and no payload.user field.\n` +
          `  task_id: ${data.task_id}\n` +
          `  framework: ${data.framework || 'unknown'}\n` +
          `  → 之前会兜底到 DB 第一个 active user（例如 witty_insight_public@huawei.com），\n` +
          `    导致 "trace 莫名其妙跑到另一个账号"。该 fallback 已下线。\n` +
          `  → 修复：在 client 配 SKILL_INSIGHT_API_KEY env 或在 payload 里设 user 字段。`
        );
        return NextResponse.json(
          {
            error: 'Missing user identity',
            detail: '上报没带 x-witty-api-key header，也没在 payload.user 写身份。Server 拒绝接收以避免数据归属错误。',
            hint: '配 SKILL_INSIGHT_API_KEY env 后重试',
          },
          { status: 400 },
        );
    }

    console.log(`[Upload-API] 📥 Received data from ${data.framework || 'unknown'}: task_id=${data.task_id}, query=${data.query?.substring(0, 50)}..., user=${username} (via ${userResolutionPath})`);

    if (data.framework === 'opencode' && data.task_id && isDeletedOpencodeSessionId(data.task_id)) {
        console.log(`[Upload-API] 🪦 Skipping deleted opencode session: task_id=${data.task_id}`);
        return NextResponse.json({ success: true, skipped: true, reason: 'deleted-opencode-session' });
    }

    // 内部 agent 标签覆盖：如果这条 trace 的 task_id 在 internal-agent-tag 里有登记，
    // 说明是我们服务自己 spawn 的 opencode（skill-generator / 评估器 / 优化器 等），
    // 用我们登记的 agentName/agentId/skill 覆盖 plugin 默认填的字段。
    if (data.task_id) {
        let tag = getInternalAgentTag(String(data.task_id)) as { agentName: string; agentId?: string | null; skill?: string; displayQuery?: string } | undefined;

        // 内存查不到时回退 DB——dev server 重启后内存映射丢了，但 SkillGeneratorSession
        // 上的 agentName/agentTraceSkill 字段还在，按 opencodeSessionId 反查能补上 trace 归属。
        if (!tag) {
            try {
                const row = await (prisma as any).skillGeneratorSession.findFirst({
                    where: { opencodeSessionId: String(data.task_id) },
                    select: { agentName: true, agentTraceSkill: true },
                });
                if (row?.agentName) {
                    tag = {
                        agentName: row.agentName,
                        skill: row.agentTraceSkill ?? undefined,
                    };
                    console.log(`[Upload-API] 🗄️ Internal agent tag from DB for task_id=${data.task_id}: agentName=${tag.agentName}`);
                }
            } catch (err) {
                // DB 查询失败不阻塞上报，trace 仍然落 Execution，只是 agentName 字段空着
                console.warn(`[Upload-API] DB tag lookup failed for task_id=${data.task_id}:`, (err as Error)?.message);
            }
        }

        if (tag) {
            data.agentName = tag.agentName;
            if (tag.agentId) data.agentId = tag.agentId;
            if (tag.skill) data.skill = tag.skill;
            if (tag.displayQuery) data.query = tag.displayQuery;
            console.log(`[Upload-API] ⭐ Internal agent tag applied for task_id=${data.task_id}: agentName=${tag.agentName} skill=${tag.skill ?? '-'}`);
        }
    }

    const interactions = data.interactions || [];
    const normalized = normalizeInteractions(interactions);
    
    normalized.forEach((turn, idx) => {
        const hasRespTool = !!turn.responseMessage?.tool_calls?.length;
        const reqToolCount = turn.requestMessages?.filter((m: any) => m.role === 'assistant' && m.tool_calls?.length).length || 0;
        console.log(`[Upload-Debug] Turn ${idx}: ReqMsgs=${turn.requestMessages?.length}, RespRole=${turn.responseMessage?.role}, RespTool=${hasRespTool}, AssistantReqTools=${reqToolCount}`);
    });

    let quickSkillsWithVersions: InvokedSkill[] = [];
    if (data.framework === 'opencode') {
        quickSkillsWithVersions = extractSkillsWithVersionsFromOpencodeSession(normalized);
    } else if (data.framework === 'claudecode' || data.framework === 'claude') {
        quickSkillsWithVersions = extractSkillsWithVersionsFromClaudeSession(normalized);
    } else if (data.framework === 'openclaw') {
        quickSkillsWithVersions = extractSkillsWithVersionsFromOpenClawSession(normalized);
    }
    
    console.log(`[Upload-API] Extracted skills: ${JSON.stringify(quickSkillsWithVersions)}`);
    
    const quickSkills = quickSkillsWithVersions.map(s => s.name);
    
    let quickSkillVersion = quickSkillsWithVersions[0]?.version ?? data.skill_version;
    console.log(`[Upload-API] Initial quickSkillVersion: ${quickSkillVersion} (from tool call: ${quickSkillsWithVersions[0]?.version}, from data: ${data.skill_version})`);
    
    if (quickSkillVersion === null || quickSkillVersion === undefined) {
        const primarySkillName = quickSkills.length > 0 ? quickSkills[0] : data.skill;
        console.log(`[Upload-API] No version from tool call, querying database for skill: ${primarySkillName}`);
        if (primarySkillName) {
            try {
                const skillRecord = await db.findSkill(primarySkillName, username || null);
                console.log(`[Upload-API] Skill record found: ${skillRecord ? skillRecord.name : 'null'}, activeVersion: ${skillRecord?.activeVersion}, versions: ${skillRecord?.versions?.map((v: any) => v.version).join(',')}`);
                if (skillRecord && skillRecord.versions && skillRecord.versions.length > 0) {
                    const targetVersion = skillRecord.activeVersion || 0;
                    const sv = skillRecord.versions.find((v: any) => v.version === targetVersion);
                    if (sv) {
                        quickSkillVersion = sv.version;
                        console.log(`[Upload-API] Quick save: using active version ${quickSkillVersion} for skill ${primarySkillName}`);
                    } else {
                        quickSkillVersion = skillRecord.versions[0].version;
                        console.log(`[Upload-API] Quick save: using fallback version ${quickSkillVersion} for skill ${primarySkillName}`);
                    }
                } else {
                    console.log(`[Upload-API] Skill record not found or no versions available`);
                }
            } catch (e) {
                console.warn(`[Upload-API] Failed to fetch skill version for ${primarySkillName}:`, e);
            }
        }
    }
    
    console.log(`[Upload-API] Final quickSkillVersion: ${quickSkillVersion}`);
    
    const quickData = { 
        ...data, 
        skip_evaluation: true,
        skills: quickSkills,
        invokedSkills: quickSkillsWithVersions,
        skill: quickSkills.length > 0 ? quickSkills[0] : data.skill,
        skill_version: quickSkillVersion
    };
    
    try {
        await saveExecutionRecord(quickData);
        if (data.framework === 'opencode' && data.opencode_cli_completed && data.task_id) {
            await db.updateSession(String(data.task_id), { endTime: new Date() });
            void triggerTrajectoryAutoWatchForTask(username, String(data.task_id), requestOrigin);
        }
        if (quickSkills.length > 0) {
            console.log(`[Upload-API] Quick save with skills: ${JSON.stringify(quickSkillsWithVersions)}`);
        }
    } catch (e) {
        console.warn(`[Upload-API] Quick initial save failed:`, e);
    }

    const userSettings = await getUserSettings(username);
    const autoEvaluationEnabled = userSettings.autoEvaluationEnabled ?? true;
    console.log(`[Upload-API] Auto evaluation enabled: ${autoEvaluationEnabled} for user: ${username}`);

    if (!autoEvaluationEnabled) {
        console.log(`[Upload-API] Auto evaluation disabled, skipping async analysis for task_id=${data.task_id}`);
        return NextResponse.json({ 
            success: true, 
            message: 'Upload received, auto evaluation disabled',
            upload_id: data.task_id,
            auto_evaluation: false
        }, { status: 200 });
    }

    const debounceMs = Number(process.env.UPLOAD_ASYNC_DEBOUNCE_MS || 15000);
    const safeDebounceMs = Number.isFinite(debounceMs) && debounceMs >= 0 ? debounceMs : 15000;
    const taskKey = `${username || 'anonymous'}::${data.task_id || ''}`;
    debounceByKey(taskKey, safeDebounceMs, () => {
        const clonedData = JSON.parse(JSON.stringify(data));
        const clonedNormalized = JSON.parse(JSON.stringify(normalized));
        const clonedInteractions = JSON.parse(JSON.stringify(interactions));
        processUploadAsync(clonedData, username, clonedNormalized, clonedInteractions, requestOrigin).catch(e => {
            if (e instanceof EvaluationCancelledError) {
                console.log(`[Upload-API] Async analysis cancelled for task_id=${clonedData.task_id}: ${e.message}`);
            } else {
                console.error('[Upload-API] Async analysis failed:', e);
            }
        });
    });

    return NextResponse.json({ 
        success: true, 
        message: 'Upload received and analyzing in background',
        upload_id: data.task_id,
        auto_evaluation: true
    }, { status: 200 });

  } catch (error) {
    console.error('[Upload-API] ❌ Error:', error);
    return NextResponse.json({ error: 'Failed to process data' }, { status: 500 });
  }
}

async function processUploadAsync(data: any, username: any, normalized: any, interactions: any, requestOrigin: string) {
    const taskId = String(data.task_id || '');
    if (!username) {
        console.log(`[Upload-Async] No username, skipping evaluation for task_id=${taskId}`);
        return;
    }

    const { runId } = startOrReplace(username, taskId, "upload");
    console.log(`[Upload-Async] Starting background analysis for ${taskId} with runId=${runId}`);

    const analysis = await analyzeSession(normalized, username);
    assertActive(username, taskId, runId);
    
    if (!data.query && analysis.query) data.query = analysis.query;
    if (!data.final_result && analysis.final_result) data.final_result = analysis.final_result;
    
    let skillsWithVersions: InvokedSkill[] = [];
    if (data.framework === 'opencode') {
        skillsWithVersions = extractSkillsWithVersionsFromOpencodeSession(normalized);
    } else if (data.framework === 'claudecode' || data.framework === 'claude') {
        skillsWithVersions = extractSkillsWithVersionsFromClaudeSession(normalized);
    } else if (data.framework === 'openclaw') {
        skillsWithVersions = extractSkillsWithVersionsFromOpenClawSession(normalized);
    }
    assertActive(username, taskId, runId);
    
    const skills = skillsWithVersions.map(s => s.name);
    
    if (skills.length > 0) {
        data.skills = skills;
        data.invokedSkills = skillsWithVersions;
        if (!data.skill) data.skill = skills[0];
        console.log(`[Upload-Async] Extracted skills: ${JSON.stringify(skillsWithVersions)}`);
        console.log(`[Upload-Async] Current data.skill_version: ${data.skill_version}`);
        if (skillsWithVersions[0]?.version != null) {
            data.skill_version = skillsWithVersions[0].version;
            console.log(`[Upload-Async] Updated skill_version from tool call: ${data.skill_version}`);
        }
        console.log(`[Upload-Async] 🛠️ Extracted Skills: ${JSON.stringify(skillsWithVersions)} for task_id=${data.task_id}`);
    } else {
        data.skills = [];
        data.invokedSkills = [];
        console.log(`[Upload-Async] ⚠️ No skills extracted for task_id=${data.task_id}`);
    }

    if (data.query) {
        data.query = data.query.trim().replace(/^['"]+|['"]+$/g, '').trim();
    }
    if (data.skill) {
        data.skill = data.skill.trim().replace(/^['"]+|['"]+$/g, '').trim();
    }

    if (!data.query) {
        console.log(`[Upload-Async] Empty query after analysis, aborting task_id=${data.task_id}`);
        finish(username, taskId, runId);
        return;
    }

    let skillDef = undefined;
    const primarySkillName = data.skill;
    console.log(`[Upload-Async] Primary skill name: ${primarySkillName}, current skill_version: ${data.skill_version}`);
    if (primarySkillName) {
          const skillRecord = await db.findSkill(primarySkillName, username || null);
          assertActive(username, taskId, runId);
          console.log(`[Upload-Async] Skill record found: ${skillRecord ? skillRecord.name : 'null'}, activeVersion: ${skillRecord?.activeVersion}, versions: ${skillRecord?.versions?.map((v: any) => v.version).join(',')}`);
          if (skillRecord && skillRecord.versions && skillRecord.versions.length > 0) {
             const targetVersion = skillRecord.activeVersion || 0;
             const sv = skillRecord.versions.find((v: any) => v.version === targetVersion);
             if (sv && sv.content) {
                 skillDef = sv.content;
                 data.skill_version = sv.version;
                 console.log(`[Upload-Async] Using active version ${sv.version} for skill ${primarySkillName}`);
             } else {
                 skillDef = skillRecord.versions[0].content;
                 data.skill_version = skillRecord.versions[0].version;
                 console.log(`[Upload-Async] Using fallback version ${skillRecord.versions[0].version} for skill ${primarySkillName}`);
             }
         }
    }

    data.skip_evaluation = true;
    data.force_judgment = false;
    await saveExecutionRecord(data);
    assertActive(username, taskId, runId);

    try {
        const dynamicResult = await analyzeDynamicOnly(data.task_id, username);
        assertActive(username, taskId, runId);
        if (dynamicResult.success) {
            console.log(`[Upload-Async] Auto-parsed dynamic flow for ${data.task_id}`);
        } else {
            console.warn(`[Upload-Async] Auto-parse dynamic flow failed for ${data.task_id}: ${dynamicResult.error}`);
        }
    } catch (e) {
        console.warn(`[Upload-Async] Auto-parse dynamic flow error for ${data.task_id}:`, e);
    }

    if (data.query && data.final_result) {
        const criteria: any = { skill_definition: skillDef };
        let cfg = undefined;
        try {
            const configs = await readConfig(username);
            assertActive(username, taskId, runId);
            cfg = findBestMatchConfig(configs, data.query, 'outcome');
            if (cfg) {
                 criteria.root_causes = cfg.root_causes;
                 criteria.key_actions = cfg.key_actions;
                 criteria.standard_answer_example = cfg.standard_answer;
            }
        } catch (e) { console.warn("Config load error", e); }

        if (cfg) {
            let executionSteps: { name: string; description: string; type: string }[] | null = null;
            try {
                const matchRecord = await db.findExecutionMatch(data.task_id);
                if (matchRecord?.extractedSteps) {
                    executionSteps = typeof matchRecord.extractedSteps === 'string' 
                        ? JSON.parse(matchRecord.extractedSteps) 
                        : matchRecord.extractedSteps;
                    console.log(`[Upload-Async] Found ${executionSteps?.length || 0} execution steps for KA evaluation`);
                }
            } catch (e) {
                console.warn(`[Upload-Async] Failed to load execution steps for KA evaluation:`, e);
            }
            assertActive(username, taskId, runId);

            const judgmentResult = await judgeAnswer(data.query, criteria, data.final_result, username, executionSteps);
            assertActive(username, taskId, runId);
            data.is_answer_correct = judgmentResult.is_correct;
            data.answer_score = judgmentResult.score;
            data.judgment_reason = judgmentResult.reason || 'Judged by Evaluation Model';
        } else {
            console.log(`[Upload-Async] No config match for query: "${data.query.substring(0, 20)}...". Skipping judgment to preserve potential existing score.`);
        }
    }

    assertActive(username, taskId, runId);
    const isEvaluatorTrace = isEvaluatorTraceRecord({
        agent: data.agent ?? data.agentName,
        agentName: data.agentName,
        agents: data.agents,
        query: data.query,
        final_result: data.final_result,
        label: data.label,
    });
    let failureAnalysis: { failures: any[]; skill_issues?: any[] };
    if (isEvaluatorTrace) {
        console.log(`[Upload-Async] Skipping analyzeFailures for evaluator trace ${taskId} (agent=${data.agentName || data.agent || 'unknown'}) — evaluator output describes evaluated case, not this session`);
        failureAnalysis = { failures: [], skill_issues: [] };
    } else {
        failureAnalysis = await analyzeFailures(
            interactions,
            primarySkillName,
            skillDef,
            data.answer_score,
            String(data.judgment_reason || ""),
            data.query,
            data.final_result,
            username
        );
    }
    assertActive(username, taskId, runId);
    data.failures = failureAnalysis.failures;
    data.skill_issues = failureAnalysis.skill_issues;

    assertActive(username, taskId, runId);
    data.skip_evaluation = false;
    data.skip_internal_judgment = true;
    await saveExecutionRecord(data);
    const shouldMarkSessionEnded = data.framework !== 'opencode' || data.opencode_cli_completed === true;
    if (taskId && shouldMarkSessionEnded) {
        try {
            await db.updateSession(taskId, { endTime: new Date() });
            void triggerTrajectoryAutoWatchForTask(username, taskId, requestOrigin);
        } catch (e) {
            console.warn(`[Upload-Async] Failed to mark session ended for ${taskId}:`, e);
        }
    }
    
    finish(username, taskId, runId);
    console.log(`[Upload-Async] ✅ Completed async analysis: task_id=${data.task_id}, score=${data.answer_score}, failures=${(data.failures || []).length}`);

}
