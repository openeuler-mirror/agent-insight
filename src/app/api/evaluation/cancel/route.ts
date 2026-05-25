import { cancel } from '@/lib/evaluation-task-manager';
import { db } from '@/lib/storage/prisma';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const data = await request.json();
    console.log(`[Cancel-API] Received request: ${JSON.stringify(data)}`);

    const taskId = data.task_id || data.upload_id;
    const user = data.currentUser;

    if (!taskId) {
      return NextResponse.json({ error: 'task_id or upload_id is required' }, { status: 400 });
    }

    if (!user) {
      return NextResponse.json({ error: 'currentUser is required' }, { status: 400 });
    }

    const existingRecord = await db.findExecutionById(taskId);
    if (existingRecord && existingRecord.user && existingRecord.user !== user) {
      return NextResponse.json({ error: 'You do not have permission to cancel this evaluation' }, { status: 403 });
    }

    const result = cancel(user, taskId);

    return NextResponse.json({
      success: true,
      cancelled: result.cancelled,
      runId: result.runId
    }, { status: 200 });

  } catch (error) {
    console.error('[Cancel-API] Error:', error);
    return NextResponse.json({ error: 'Failed to cancel evaluation' }, { status: 500 });
  }
}