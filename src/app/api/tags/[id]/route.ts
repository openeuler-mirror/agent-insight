import { NextResponse } from 'next/server';
import { deleteTraceTag, updateTraceTag, getTraceTagKind, TraceTagError } from '@/lib/trace-tags';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import { isUsageEnabled } from '@/lib/usage-analytics/config';

export const dynamic = 'force-dynamic';

function toErrorResponse(error: unknown) {
  if (error instanceof TraceTagError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error('[tags/id] request failed:', error);
  return NextResponse.json({ error: 'failed to process tag request' }, { status: 500 });
}

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    const user = String(body.user || '').trim();
    const updated = await updateTraceTag(user, id, body);

    if (updated?.kind === 'version') {
      recordUsageEvent({ user, featureKey: 'version-management', eventKey: 'version.tag.update' });
    }

    return NextResponse.json(updated);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);
    const user = searchParams.get('user') || '';

    // 删除后拿不到 kind，只能先读一次再删；这次额外查询只在统计开启时才做，
    // 关闭时 DELETE 的数据库往返次数与接入统计前完全一致。
    const kind = isUsageEnabled() ? await getTraceTagKind(user, id) : null;
    await deleteTraceTag(user, id);

    if (kind === 'version') {
      recordUsageEvent({ user, featureKey: 'version-management', eventKey: 'version.tag.delete' });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}