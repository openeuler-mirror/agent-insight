import { NextRequest, NextResponse } from 'next/server';
import { cancelSkillGeneratorRun } from '@/lib/skill-generator-task-manager';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { user, threadId } = body ?? {};

    if (!user || !threadId) {
      return NextResponse.json(
        { error: 'Missing required fields: user, threadId' },
        { status: 400 }
      );
    }

    const result = cancelSkillGeneratorRun(user, threadId);
    return NextResponse.json(
      {
        success: true,
        cancelled: result.cancelled,
        runId: result.runId,
      },
      { status: 200 }
    );
  } catch (error: any) {
    console.error('[Skill-Generator Stop Route Error]:', error);
    return NextResponse.json(
      { error: error?.message || 'Internal Server Error' },
      { status: 500 }
    );
  }
}
