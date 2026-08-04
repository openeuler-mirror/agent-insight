import { NextResponse } from 'next/server';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import { extractTaskArtifacts } from '@/lib/engine/evaluation/task-artifacts';
import { inferSubagentNamesFromInteractions } from '@/lib/engine/observability/subagent-inference';
import { db } from '@/lib/storage/prisma';
import { normalizeClaudeCodeInteractionsForStorage } from '@/lib/shared/interaction-content';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const user = String(body.user || '').trim();
    const requestedTaskId = String(body.taskId || '').trim();
    const executionId = String(body.executionId || '').trim();
    if (!user || (!requestedTaskId && !executionId)) {
      return NextResponse.json({ error: 'user and taskId or executionId are required' }, { status: 400 });
    }

    const executions = await db.findExecutions(
      executionId ? { id: executionId, user } : { taskId: requestedTaskId, user },
      { timestamp: 'desc' },
    );
    const execution = executions[0];
    if (!execution) {
      return NextResponse.json({ error: 'trace not found' }, { status: 404 });
    }
    const taskId = String(execution.taskId || requestedTaskId).trim();
    const session = taskId ? await db.findSessionByTaskId(taskId) : null;
    if (!session || String(session.user || '') !== user) {
      return NextResponse.json({ error: 'trace session not found' }, { status: 404 });
    }

    let interactions: unknown[] = [];
    try {
      const parsed = JSON.parse(session.interactions || '[]');
      interactions = Array.isArray(parsed) ? parsed : [];
    } catch {
      return NextResponse.json({ error: 'trace interactions are invalid' }, { status: 422 });
    }
    if (execution.framework === 'claudecode') {
      interactions = normalizeClaudeCodeInteractionsForStorage(interactions);
    }
    interactions = inferSubagentNamesFromInteractions(interactions as Record<string, unknown>[]);

    const artifacts = await extractTaskArtifacts({
      rawInput: String(execution.query || session.query || ''),
      fallbackOutput: String(execution.finalResult || ''),
      interactions,
    });

    recordUsageEvent({ user, featureKey: 'trace', eventKey: 'trace.draft.save' });

    return NextResponse.json({
      draft: {
        values: { input: artifacts.input, output: artifacts.output, trace: artifacts.trace },
        traceSource: {
          taskId,
          executionId: String(execution.id || '') || undefined,
          capturedAt: new Date().toISOString(),
        },
      },
      warnings: artifacts.warnings,
    });
  } catch (error) {
    console.error('agent-datasets trace-drafts POST error:', error);
    return NextResponse.json({ error: 'failed to build trace draft' }, { status: 500 });
  }
}
