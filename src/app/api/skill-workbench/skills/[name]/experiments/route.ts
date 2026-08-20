import { NextRequest, NextResponse } from 'next/server';

import { resolveUser } from '@/lib/auth/auth';
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
    const result = await listWorkbenchExperiments(username, decodeURIComponent(name));
    if (!result) return NextResponse.json({ error: 'Skill 不存在或无访问权限' }, { status: 404 });
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
    if (
      typeof body.sessionId !== 'string' || typeof body.datasetId !== 'string'
      || !Number.isInteger(version) || !WORKBENCH_EXPERIMENT_PRESETS.includes(preset)
      || (compareVersion !== undefined && !Number.isInteger(compareVersion))
    ) return NextResponse.json({ error: '实验配置不合法' }, { status: 400 });
    const result = await createWorkbenchExperiment({
      user: username,
      sessionId: body.sessionId,
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
      modelConfigId: typeof body.modelConfigId === 'string' ? body.modelConfigId : undefined,
    });
    if (result.kind === 'invalid_context') return NextResponse.json({ error: '实验只能绑定管理中心选择的正式工作版本' }, { status: 409 });
    if (result.kind === 'not_found') return NextResponse.json({ error: 'Skill 或版本不存在' }, { status: 404 });
    if (result.kind === 'invalid_compare') return NextResponse.json({ error: 'A/B 必须选择不同且存在的对照版本' }, { status: 400 });
    if (result.kind === 'invalid_dataset') return NextResponse.json({ error: '评测数据集不存在、为空或绑定了其他 Skill' }, { status: 400 });
    if (result.kind === 'invalid_cases') return NextResponse.json({ error: '已选 Case 不属于当前数据集或已失效' }, { status: 400 });
    if (result.kind === 'invalid_trigger_dataset') {
      return NextResponse.json({ error: '触发分析数据集必须同时包含应触发与不应触发标注' }, { status: 400 });
    }
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    console.error('[skill-workbench experiments POST] failed:', error);
    return NextResponse.json({ error: '创建 Skill 实验失败' }, { status: 500 });
  }
}
