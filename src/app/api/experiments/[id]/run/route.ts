// 触发实验执行：置 running + 逐行异步执行（fire-and-forget），立即返回当前状态。
import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { startExperimentRun } from '@/lib/engine/experiment/run-experiment';

export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const { username } = await resolveUser(req, url.searchParams.get('user'));
    if (!username) {
      return NextResponse.json({ error: 'user is required' }, { status: 400 });
    }

    const result = await startExperimentRun(id, username);
    if (!result) {
      return NextResponse.json({ error: 'experiment not found' }, { status: 404 });
    }
    // 执行在后台继续；错误已在引擎内逐行落库
    result.completion?.catch((e) => {
      console.error('[Experiment Run Error]', e);
    });
    return NextResponse.json({
      status: result.status,
      ...(result.alreadyRunning ? { alreadyRunning: true } : {}),
    });
  } catch (error) {
    console.error('[Experiment Run Error]', error);
    return NextResponse.json({ error: 'Failed to start experiment run' }, { status: 500 });
  }
}
