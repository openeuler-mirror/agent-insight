import { analyzeSession } from '@/lib/engine/evaluation/judge';
import { db } from '@/lib/storage/prisma';
import { inferSubagentNamesFromInteractions } from '@/lib/engine/observability/subagent-inference';
import { normalizeClaudeCodeInteractionsForStorage } from '@/lib/shared/interaction-content';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const taskId = searchParams.get('taskId');

    if (!taskId) {
        return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
    }

    try {
        const session = await db.findSessionByTaskId(taskId);

        if (!session) {
            return NextResponse.json({ error: 'Session not found' }, { status: 404 });
        }

        const rawInteractions = session.interactions ? JSON.parse(session.interactions) : [];
        const executions = await db.findExecutions({ taskId }, { timestamp: 'desc' });
        const framework = executions?.[0]?.framework;
        const sessionInteractions = framework === 'claudecode'
            ? normalizeClaudeCodeInteractionsForStorage(rawInteractions)
            : rawInteractions;
        const interactions = inferSubagentNamesFromInteractions(sessionInteractions);
        
        let query = session.query;
        if (!query && interactions.length > 0) {
            try {
                const analysis = await analyzeSession(interactions, session.user);
                if (analysis.query) {
                    query = analysis.query;
                    db.updateSession(taskId, { query }).catch(console.error);
                }
            } catch (e) {
                console.warn('Failed to extract query on the fly', e);
            }
        }

        return NextResponse.json({
            taskId: session.taskId,
            label: session.label,
            query: query,
            user: session.user,
            startTime: session.startTime.getTime(),
            interactions: interactions,
        });
    } catch (e) {
        console.error('Error reading session from DB:', e);
        return NextResponse.json({ error: 'Failed to read session' }, { status: 500 });
    }
}
