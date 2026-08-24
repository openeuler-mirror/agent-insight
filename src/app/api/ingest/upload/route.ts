import { saveExecutionRecord, extractInvokedSkillsFromSessionInteractions, getDefaultIngestUser } from '@/lib/storage/data-service';
import { isDeletedOpencodeSessionId } from '@/lib/ingest/opencode-deleted-sessions';
import { analyzeDynamicOnly } from '@/lib/engine/observability/flow-parser';
import { analyzeFailures, analyzeSession, InvokedSkill, normalizeInteractions } from '@/lib/engine/evaluation/judge';
import { isEvaluatorTraceRecord } from '@/lib/evaluator-agent';
import { db, prisma } from '@/lib/storage/prisma';
import { normalizeEndpointUrl } from '@/lib/infra/endpoint-resolve';
import { debounceByKey } from '@/lib/ingest/upload-analysis-debouncer';
import { getUserSettings } from '@/lib/storage/server-config';
import { assertActive, finish, startOrReplace, EvaluationCancelledError } from '@/lib/evaluation-task-manager';
import { getInternalAgentTag } from '@/lib/internal-agent-tag';
import { triggerExperimentWatchForTask } from '@/lib/engine/experiment/experiment-watch';
import { NextResponse } from 'next/server';
import { clientIpFromRequest } from '@/lib/reliability/client-ip';
import { normalizeTraceClientMetadata } from '@/lib/reliability/trace-client';
import { authenticateDevice } from '@/lib/reliability/client-registry';
import { reliabilityErrorResponse } from '@/lib/reliability/api-error';

/**
 * 这一发 opencode 上报是不是"进行中快照"——是的话只落库，不跑异步 LLM 分析。
 *
 * 判定依据必须是**本轮对话是否跑完**，不能用 CLI 是否退出：opencode 正常交互式使用时
 * CLI 会一直开着，拿 opencode_cli_completed 当门会把每一条 trace 都判成进行中，评分 /
 * 诊断 / 流程图要等用户退出 opencode 才出，属于严重倒退（曾经上线过一版，已修）。
 *
 * trace_completed_at 由 uploader 在「已产出终稿 && 会话已 idle」时写入，正是本轮结束的
 * 信号；工具死循环的心跳快照两个条件都不满足，自然落进轻通道。
 */
export function isInProgressOpencodeSnapshot(data: {
    framework?: unknown;
    trace_completed_at?: unknown;
    opencode_cli_completed?: unknown;
}): boolean {
    if (String(data.framework ?? '').toLowerCase() !== 'opencode') return false;
    if (data.opencode_cli_completed === true) return false;
    if (String(data.trace_completed_at ?? '').trim()) return false;
    return true;
}

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
    const isOpenCodeTrace = String(data.framework || '').toLowerCase() === 'opencode';
    const authorization = headers.get('authorization') || '';
    const deviceAuthRequested = isOpenCodeTrace && Boolean(
      headers.get('x-agent-insight-client-id') || /^Bearer\s+dc_/i.test(authorization.trim()),
    );
    let deviceIdentity: { clientId: string; user: string } | null = null;
    let deviceAuthError: unknown = null;
    if (deviceAuthRequested) {
      try {
        deviceIdentity = await authenticateDevice(request);
      } catch (error) {
        deviceAuthError = error;
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // User 解析：至少一份服务端可验证凭证有效
    // 之前这里有第 3 级"fallback 到 DB 第一个 active user"的兜底，导致一个隐性
    // 大坑——如果 client 的 .env 里 API key 配错（DB 里没这把 key），server 不
    // 报错 + 不拒收，反而把数据**静默归到一个公共账号**（例如
    // witty_insight_public@huawei.com）。运维 / 用户从 client 端完全感知不到
    // 出了什么事，UI 上看自己账号永远是空的，数据却在另一个账号下越堆越多。
    //
    // 现在的规则：
    //   1. API Key / 设备凭证任一有效即可；两者都有效时必须属于同一账号
    //   2. 一份凭证失效、另一份有效 → 接受，但不使用失效凭证做客户端绑定
    //   3. 两份均失效 → reject；避免服务重建后的旧设备凭证拦掉仍有效的 API Key
    //   4. apiKey 没提供 + payload.user 有 → 接受（向后兼容），但 warn 标记
    //      "未经鉴权" —— payload.user 不需要任何验证，谁都能伪造
    //   5. apiKey 没提供 + payload.user 也没有 → 400 reject + 报错
    // ─────────────────────────────────────────────────────────────────────
    let username: string | undefined;
    let apiKeyUser: string | null = null;
    let userResolutionPath: 'api-key' | 'device-credential' | 'payload-user-unauth' | 'default-ingest-user' | 'none' = 'none';

    if (apiKey) {
      const user = await db.findUserByApiKey(apiKey);
      if (user) {
        apiKeyUser = user.username;
        username = user.username;
        data.user = username;
        userResolutionPath = 'api-key';
        console.log(`[Upload-API] ✓ User resolved via API Key: ${username}`);
      }
    }

    if (deviceIdentity) {
      if (username && username !== deviceIdentity.user) {
        return NextResponse.json(
          {
            error: 'Device account mismatch',
            detail: '设备凭证与 API Key 不属于同一账号，已拒绝客户端绑定。',
          },
          { status: 403 },
        );
      }
      username = deviceIdentity.user;
      data.user = username;
      userResolutionPath = apiKeyUser ? 'api-key' : 'device-credential';
    }

    if (deviceAuthError && !apiKeyUser) {
      return reliabilityErrorResponse(deviceAuthError, 'trace-upload-device-auth');
    }
    if (deviceAuthError && apiKeyUser) {
      console.warn(
        `[Upload-API] ⚠ Device credential rejected; accepting the trace via the valid API key without client binding. task_id=${data.task_id}`,
      );
    }

    if (apiKey && !apiKeyUser && !deviceIdentity) {
      const keyPrefix = apiKey.slice(0, 12);
      console.error(
        `[Upload-API] ❌ Rejecting upload (HTTP 401): API key not found in User table.\n` +
        `  Key prefix: ${keyPrefix}...\n` +
        `  task_id: ${data.task_id}\n` +
        `  framework: ${data.framework || 'unknown'}\n` +
        `  payload.user (untrusted): ${data.user || '(none)'}\n` +
        `  → 检查 .env 里 AGENT_INSIGHT_API_KEY 是否与 DB 中某个 User.apiKey 完全一致。`
      );
      return NextResponse.json(
        {
          error: 'Invalid API key',
          detail: 'API Key 在 User 表里没匹配。Server 拒绝接收以避免数据跑到错误账号。',
          keyPrefix: keyPrefix + '...',
          hint: '检查 AGENT_INSIGHT_API_KEY env 与 server DB 里目标 User.apiKey 是否一致',
        },
        { status: 401 },
      );
    }
    if (apiKey && !apiKeyUser && deviceIdentity) {
      console.warn(
        `[Upload-API] ⚠ API key rejected; accepting the trace via the valid device credential. task_id=${data.task_id}`,
      );
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
        // 完全没带 key、也没 payload.user 时：
        //   - 配了 AGENT_INSIGHT_DEFAULT_INGEST_USER → 归到该默认共享账号（开箱即用，client 只需填 IP）
        //   - 没配 → 保持硬拒绝（历史踩坑的「静默兜底到 DB 第一个用户」已下线）
        // 注意：这里只处理「完全没带 key」；「带了 key 但查不到」在上面已 401，不会静默落到共享账号。
        const defaultUser = getDefaultIngestUser();
        if (defaultUser) {
            username = defaultUser;
            data.user = username;
            userResolutionPath = 'default-ingest-user';
            console.warn(
              `[Upload-API] ⚠ No API key / user — defaulting to AGENT_INSIGHT_DEFAULT_INGEST_USER: ${username}\n` +
              `  task_id: ${data.task_id}, framework: ${data.framework || 'unknown'}`
            );
        } else {
            console.error(
              `[Upload-API] ❌ Rejecting upload (HTTP 400): no x-witty-api-key header and no payload.user field.\n` +
              `  task_id: ${data.task_id}\n` +
              `  framework: ${data.framework || 'unknown'}\n` +
              `  → 之前会兜底到 DB 第一个 active user（例如 witty_insight_public@huawei.com），\n` +
              `    导致 "trace 莫名其妙跑到另一个账号"。该 fallback 已下线。\n` +
              `  → 修复：服务端配 AGENT_INSIGHT_DEFAULT_INGEST_USER（共享账号场景），或 client 配 AGENT_INSIGHT_API_KEY env。`
            );
            return NextResponse.json(
              {
                error: 'Missing user identity',
                detail: '上报没带 x-witty-api-key header，也没在 payload.user 写身份，且服务端未配 AGENT_INSIGHT_DEFAULT_INGEST_USER。Server 拒绝接收以避免数据归属错误。',
                hint: '服务端配 AGENT_INSIGHT_DEFAULT_INGEST_USER，或 client 配 AGENT_INSIGHT_API_KEY env',
              },
              { status: 400 },
            );
        }
    }

    console.log(`[Upload-API] 📥 Received data from ${data.framework || 'unknown'}: task_id=${data.task_id}, query=${data.query?.substring(0, 50)}..., user=${username} (via ${userResolutionPath})`);

    if (data.endpoint) {
        data.endpoint = normalizeEndpointUrl(data.endpoint) ?? undefined;
    }

    if (isOpenCodeTrace) {
      const reportedClientMetadata = normalizeTraceClientMetadata(data);
      const clientMetadata = {
        ...reportedClientMetadata,
        observedIp: clientIpFromRequest(request, {
          allowDirectConnection: Boolean(deviceIdentity) || userResolutionPath === 'api-key',
          clientHostName: reportedClientMetadata.hostName,
        }),
      };
      if (
        deviceIdentity &&
        clientMetadata.clientId &&
        clientMetadata.clientId !== deviceIdentity.clientId
      ) {
        return NextResponse.json(
          { error: 'Device client mismatch', detail: '设备凭证与 Trace 中的 clientId 不一致。' },
          { status: 403 },
        );
      }
      data.clientId = deviceIdentity?.clientId ?? undefined;
      data.hostIp = clientMetadata.hostIp ?? undefined;
      data.hostName = clientMetadata.hostName ?? undefined;
      data.observedIp = clientMetadata.observedIp ?? undefined;
    }

    if (data.framework === 'opencode' && data.task_id && isDeletedOpencodeSessionId(data.task_id)) {
        console.log(`[Upload-API] 🪦 Skipping deleted opencode session: task_id=${data.task_id}`);
        return NextResponse.json({ success: true, skipped: true, reason: 'deleted-opencode-session' });
    }

    // 内部 agent 标签覆盖：如果这条 trace 的 task_id 在 internal-agent-tag 里有登记，
    // 说明是我们服务自己 spawn 的 opencode（skill-generator / 评估器 / 优化器 等），
    // 用我们登记的 agentName/agentId/skill 覆盖 plugin 默认填的字段。
    if (data.task_id) {
        let tag = getInternalAgentTag(String(data.task_id)) as { agentName: string; agentId?: string | null; skill?: string; displayQuery?: string; user?: string } | undefined;

        // 内存查不到时回退 DB——dev server 重启后内存映射丢了，但 SkillGeneratorSession
        // 上的 agentName/agentTraceSkill/user 字段还在，按 opencodeSessionId 反查能补上 trace 归属。
        if (!tag) {
            try {
                const row = await (prisma as any).skillGeneratorSession.findFirst({
                    where: { opencodeSessionId: String(data.task_id) },
                    select: { agentName: true, agentTraceSkill: true, user: true },
                });
                if (row?.agentName) {
                    tag = {
                        agentName: row.agentName,
                        skill: row.agentTraceSkill ?? undefined,
                        user: row.user ?? undefined,
                    };
                    console.log(`[Upload-API] 🗄️ Internal agent tag from DB for task_id=${data.task_id}: agentName=${tag.agentName} user=${tag.user ?? '-'}`);
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
            // 归属修正(根治"无脑往 admin 写"): 内部 agent(灰度 A/B、评测、skill-gen)的 trace 由服务端
            // spawn 的 opencode 产生, 其 telemetry 常被服务端 uploader 用服务账号 key 上报 → 误记到 admin。
            // tag.user 是 runner 登记的"真正触发用户"(服务端写入、可信), 以它为准覆盖 api-key 归属。
            if (tag.user && tag.user !== username) {
                console.log(`[Upload-API] ⭐ 归属修正: ${username} → ${tag.user} (internal agent ${tag.agentName}, task_id=${data.task_id})`);
                username = tag.user;
                data.user = tag.user;
                if (deviceIdentity && tag.user !== deviceIdentity.user) {
                    data.clientId = undefined;
                }
            }
            console.log(`[Upload-API] ⭐ Internal agent tag applied for task_id=${data.task_id}: agentName=${tag.agentName} skill=${tag.skill ?? '-'} user=${username}`);
        }
    }

    const interactions = data.interactions || [];
    const normalized = normalizeInteractions(interactions);
    
    normalized.forEach((turn, idx) => {
        const hasRespTool = !!turn.responseMessage?.tool_calls?.length;
        const reqToolCount = turn.requestMessages?.filter((m: any) => m.role === 'assistant' && m.tool_calls?.length).length || 0;
        console.log(`[Upload-Debug] Turn ${idx}: ReqMsgs=${turn.requestMessages?.length}, RespRole=${turn.responseMessage?.role}, RespTool=${hasRespTool}, AssistantReqTools=${reqToolCount}`);
    });

    const quickSkillsWithVersions: InvokedSkill[] = extractInvokedSkillsFromSessionInteractions(data.framework, normalized) ?? [];
    
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
            void triggerExperimentWatchForTask(username, String(data.task_id));
        }
        if (quickSkills.length > 0) {
            console.log(`[Upload-API] Quick save with skills: ${JSON.stringify(quickSkillsWithVersions)}`);
        }
    } catch (e) {
        // 之前这里只 warn 然后照常返回 200 success。后果是"落库失败但客户端以为成功"：
        // opencode uploader 会把这次的 sig 写进 checkpoint，之后内容没大变化就再也不重传，
        // 这条 trace 永久丢失且两端都无感。改成 5xx，让客户端不记 checkpoint、下轮自动重试。
        console.error(
            `[Upload-API] ❌ Quick initial save failed (HTTP 500): task_id=${data.task_id}, framework=${data.framework || 'unknown'}, user=${username}\n`,
            e,
        );
        return NextResponse.json(
            {
                error: 'Failed to persist execution record',
                detail: '上报已收到但落库失败，客户端请勿标记为已上传，稍后重试。',
                upload_id: data.task_id,
            },
            { status: 500 },
        );
    }

    // 进行中的 opencode 快照走轻通道：只落库（上面的 quick save 已完成），跳过异步分析。
    // 异步分析包含流程图解析和失败归因。心跳上报开启后，一个长任务会每分钟推一次快照，
    // 若每次都跑完整分析：① 成本随任务时长线性叠加，输入还是越来越大的全量 trace；
    // ② 对一个尚未产出终稿的半截 trace，打分和失败归因本身没有意义，还会用中间态结论
    // 覆盖掉最终那次的正确结论。等 CLI 真正退出（opencode_cli_completed=true）再评一次。
    const isInProgressOpencode = isInProgressOpencodeSnapshot(data);
    if (isInProgressOpencode) {
        console.log(`[Upload-API] ⏳ In-progress opencode snapshot, saved without analysis: task_id=${data.task_id}`);
        return NextResponse.json({
            success: true,
            message: 'In-progress snapshot saved; analysis deferred until session completes',
            upload_id: data.task_id,
            auto_evaluation: false,
            background_analysis: false,
            in_progress: true,
        }, { status: 200 });
    }

    const userSettings = await getUserSettings(username);
    const backgroundAnalysisEnabled = userSettings.autoEvaluationEnabled ?? true;
    console.log(`[Upload-API] Background flow/failure analysis enabled: ${backgroundAnalysisEnabled} for user: ${username}`);

    if (!backgroundAnalysisEnabled) {
        console.log(`[Upload-API] Background analysis disabled, skipping async analysis for task_id=${data.task_id}`);
        return NextResponse.json({ 
            success: true, 
            message: 'Upload received, background analysis disabled',
            upload_id: data.task_id,
            auto_evaluation: false,
            background_analysis: false,
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
        auto_evaluation: false,
        background_analysis: true,
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
    
    const skillsWithVersions: InvokedSkill[] = extractInvokedSkillsFromSessionInteractions(data.framework, normalized) ?? [];
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
            void triggerExperimentWatchForTask(username, taskId);
        } catch (e) {
            console.warn(`[Upload-Async] Failed to mark session ended for ${taskId}:`, e);
        }
    }
    
    finish(username, taskId, runId);
    console.log(`[Upload-Async] ✅ Completed async analysis: task_id=${data.task_id}, score=${data.answer_score}, failures=${(data.failures || []).length}`);

}
