import { NextRequest, NextResponse } from 'next/server';

import { resolveUser } from '@/lib/auth/auth';
import { TraceGenerationError } from '@/lib/engine/experiment/trace-generation';
import {
  DEFAULT_EXPERIMENT_AGENT_TIMEOUT_SECONDS,
  isValidExperimentAgentTimeoutSeconds,
} from '@/lib/engine/experiment/constants';
import {
  createWorkbenchExperiment,
  listWorkbenchExperiments,
  WORKBENCH_EXPERIMENT_PRESETS,
  type WorkbenchExperimentPreset,
} from '@/lib/skill-workbench/experiment-service';

export async function GET(request: NextRequest, context: { params: Promise<{ name: string }> }) {
  try {
    const { username } = await resolveUser(request, request.nextUrl.searchParams.get('user'));
    if (!username) return NextResponse.json({ error: '缺少用户信息' }, { status: 401 });
    const { name } = await context.params;
    const versionParam = request.nextUrl.searchParams.get('version');
    const version = Number(versionParam);
    if (versionParam == null || versionParam.trim() === '' || !Number.isInteger(version) || version < 0) {
      return NextResponse.json({ error: '缺少有效的 Skill 版本' }, { status: 400 });
    }
    const result = await listWorkbenchExperiments(username, decodeURIComponent(name), version);
    if (!result) return NextResponse.json({ error: 'Skill、版本不存在或无访问权限' }, { status: 404 });
    return NextResponse.json(result);
  } catch (error) {
    console.error('[skill-workbench experiments GET] failed:', error);
    return NextResponse.json({ error: '加载 Skill 实验失败' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ name: string }> }) {
  try {
    const body = await request.json();
    const { username } = await resolveUser(request, body.user);
    if (!username) return NextResponse.json({ error: '缺少用户信息' }, { status: 401 });
    const { name } = await context.params;
    const preset = body.preset as WorkbenchExperimentPreset;
    const version = Number(body.version);
    const compareVersion = body.compareVersion == null ? undefined : Number(body.compareVersion);
    const agentTimeoutSeconds = body.agentTimeoutSeconds == null
      ? DEFAULT_EXPERIMENT_AGENT_TIMEOUT_SECONDS
      : Number(body.agentTimeoutSeconds);
    if (
      typeof body.datasetId !== 'string'
      || !Number.isInteger(version) || !WORKBENCH_EXPERIMENT_PRESETS.includes(preset)
      || (compareVersion !== undefined && !Number.isInteger(compareVersion))
    ) return NextResponse.json({ error: '实验配置不合法' }, { status: 400 });
    if (!isValidExperimentAgentTimeoutSeconds(agentTimeoutSeconds)) {
      return NextResponse.json({ error: 'Agent 单次执行上限必须是 30～3600 之间的整数秒数' }, { status: 400 });
    }
    const result = await createWorkbenchExperiment({
      user: username,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
      skillName: decodeURIComponent(name),
      version,
      preset,
      datasetId: body.datasetId,
      compareVersion,
      versionAEnabled: body.versionAEnabled !== false,
      optimizationRecordId: typeof body.optimizationRecordId === 'string' ? body.optimizationRecordId : undefined,
      name: typeof body.name === 'string' ? body.name : undefined,
      agentName: typeof body.agentName === 'string' ? body.agentName : undefined,
      evaluatorIds: Array.isArray(body.evaluatorIds) ? body.evaluatorIds.map(String) : undefined,
      caseIds: Array.isArray(body.caseIds) ? body.caseIds.map(String) : undefined,
      traceSource: body.traceSource === 'existing' ? 'existing' : 'generate',
      traceGenerationTarget: body.traceSource === 'existing' || !body.traceGenerationTarget
        ? null
        : {
            host: String(body.traceGenerationTarget.host || '').trim().slice(0, 200),
            platform: String(body.traceGenerationTarget.platform || '').trim().slice(0, 100),
            model: typeof body.traceGenerationTarget.model === 'string'
              ? body.traceGenerationTarget.model.trim().slice(0, 200) || null
              : null,
          },
      modelConfigId: typeof body.modelConfigId === 'string' ? body.modelConfigId : undefined,
      executionTarget: body.executionTarget,
      agentTimeoutSeconds,
    });
    if (result.kind === 'invalid_context') return NextResponse.json({ error: '实验关联的工作会话已失效' }, { status: 409 });
    if (result.kind === 'not_found') return NextResponse.json({ error: 'Skill 或版本不存在' }, { status: 404 });
    if (result.kind === 'invalid_compare') return NextResponse.json({ error: 'A/B 必须选择不同且存在的对照版本' }, { status: 400 });
    if (result.kind === 'invalid_dataset') return NextResponse.json({ error: '评测数据集不存在、为空或不适用于当前实验类型' }, { status: 400 });
    if (result.kind === 'invalid_cases') return NextResponse.json({ error: '已选 Case 不属于当前数据集或已失效' }, { status: 400 });
    if (result.kind === 'invalid_evaluators') return NextResponse.json({ error: '当前实验类型不支持所选评估器' }, { status: 400 });
    if (result.kind === 'invalid_trigger_model') return NextResponse.json({ error: '触发分析必须明确选择运行模型，不能使用平台默认模型' }, { status: 400 });
    if (result.kind === 'invalid_agent_timeout') {
      return NextResponse.json({ error: 'Agent 单次执行上限必须是 30～3600 之间的整数秒数' }, { status: 400 });
    }
    if (result.kind === 'invalid_trigger_dataset') {
      return NextResponse.json({ error: '触发分析数据集必须同时包含应触发与不应触发标注' }, { status: 400 });
    }
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    console.error('[skill-workbench experiments POST] failed:', error);
    if (error instanceof TraceGenerationError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.httpStatus });
    return NextResponse.json({ error: '创建 Skill 实验失败' }, { status: 500 });
  }
}
