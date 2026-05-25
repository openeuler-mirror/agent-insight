import { NextResponse } from 'next/server';
import { prismaRaw } from '@/lib/storage/prisma';
import { addDeletedOpencodeSessionIds } from '@/lib/ingest/opencode-deleted-sessions';

export const dynamic = 'force-dynamic';

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let agentIdForLog = 'unknown';
  try {
    const { id } = await params;
    agentIdForLog = id;
    if (!id) {
      return NextResponse.json({ error: 'Missing agent ID' }, { status: 400 });
    }

    // 0. 查找对应的 Agent 以获取其 name 和 platform
    const agent = await (prismaRaw as any).registeredAgent.findUnique({
      where: { id }
    });
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    // 1. 获取所有关联的 Executions
    // 针对 user 字段额外加上 { user: '' } 防止空字符串的脏数据匹配不到
    const executionWhere = {
      OR: [
        { agentId: id },
        {
          agentName: agent.name,
          framework: agent.platform,
          ...(agent.user ? { OR: [{ user: agent.user }, { user: null }, { user: '' }] } : {})
        }
      ]
    };

    const executions = await (prismaRaw as any).execution.findMany({
      where: executionWhere,
      select: { id: true, taskId: true, framework: true },
    });
    const executionIds = executions.map((e: any) => e.id);
    const deletedOpencodeSessionIds = executions
      .filter((e: any) => (e.framework || agent.platform) === 'opencode')
      .flatMap((e: any) => [e.taskId, e.id])
      .filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0);

    const transaction = [];

    if (executionIds.length > 0) {
      // 2. 清理 Evaluation 及其关联的 SkillIssue
      const evals = await (prismaRaw as any).evaluation.findMany({
        where: { executionId: { in: executionIds } },
        select: { id: true },
      });
      const evalIds = evals.map((e: any) => e.id);
      
      if (evalIds.length > 0) {
        transaction.push((prismaRaw as any).skillIssue.deleteMany({ where: { evaluationId: { in: evalIds } } }));
        transaction.push((prismaRaw as any).evaluation.deleteMany({ where: { executionId: { in: executionIds } } }));
      }

      // 3. 清理 FaultDiagnosisSession 及其关联的 Messages
      const diagSessions = await (prismaRaw as any).faultDiagnosisSession.findMany({
        where: { executionId: { in: executionIds } },
        select: { id: true },
      });
      const diagSessionIds = diagSessions.map((s: any) => s.id);

      if (diagSessionIds.length > 0) {
        transaction.push((prismaRaw as any).faultDiagnosisMessage.deleteMany({ where: { sessionId: { in: diagSessionIds } } }));
        transaction.push((prismaRaw as any).faultDiagnosisSession.deleteMany({ where: { id: { in: diagSessionIds } } }));
      }

      // 4. 清理其他关联表
      transaction.push((prismaRaw as any).executionMatch.deleteMany({ where: { executionId: { in: executionIds } } }));
      transaction.push((prismaRaw as any).trajectoryEvalResult.deleteMany({ where: { executionId: { in: executionIds } } }));
      
      // 5. 最后清理 Execution
      // 直接复用查询条件进行删除，避免 executionIds 数组过长触发 SQLite 绑定变量超限
      transaction.push((prismaRaw as any).execution.deleteMany({
        where: executionWhere
      }));
    }

    // 6. 删除 Agent 本身
    transaction.push((prismaRaw as any).registeredAgent.delete({ where: { id } }));

    await (prismaRaw as any).$transaction(transaction);
    const tombstoned = addDeletedOpencodeSessionIds(deletedOpencodeSessionIds);

    return NextResponse.json({ success: true, deletedTraces: executionIds.length, tombstonedSessions: tombstoned });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[agents][DELETE] error for id ${agentIdForLog}:`, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
