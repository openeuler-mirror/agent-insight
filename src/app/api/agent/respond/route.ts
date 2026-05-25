import { NextResponse } from 'next/server';
import { resolveInteraction } from '@/lib/engine/general-agent/pending-requests';

export const dynamic = 'force-dynamic';

/**
 * 应答 SSE 流推送的 permission/question 事件。
 *
 * Request:
 *   { requestId: string, user: string, kind: 'permission'|'question', reply: any }
 *
 *   - kind='permission' 时 reply 必须是 'once' | 'always' | 'reject'
 *   - kind='question'   时 reply 必须是 数组（answers）或 null（拒绝回答）
 *
 * Response:
 *   200 { success: true }                         应答成功，runner 已 resume
 *   404 { error: 'request not found' }            requestId 不存在或已超时/取消
 *   400 { error: ... }                            参数错误
 *   403 { error: 'user mismatch' }                user 不是该请求归属者
 */
export async function POST(request: Request) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid json body' }, { status: 400 });
  }

  const requestId = String(body?.requestId || '').trim();
  const user = String(body?.user || '').trim();
  const kind = String(body?.kind || '').trim();
  if (!requestId || !user) {
    return NextResponse.json({ error: 'requestId and user are required' }, { status: 400 });
  }
  if (kind !== 'permission' && kind !== 'question') {
    return NextResponse.json(
      { error: "kind must be 'permission' or 'question'" },
      { status: 400 },
    );
  }

  // 校验 reply 形态
  let reply: any = body?.reply;
  if (kind === 'permission') {
    if (reply !== 'once' && reply !== 'always' && reply !== 'reject') {
      return NextResponse.json(
        { error: "permission reply must be 'once' | 'always' | 'reject'" },
        { status: 400 },
      );
    }
  } else {
    // question: 允许 null 或数组
    if (reply != null && !Array.isArray(reply)) {
      return NextResponse.json(
        { error: 'question reply must be an array or null' },
        { status: 400 },
      );
    }
    if (reply == null) reply = null;
  }

  try {
    const ok = resolveInteraction(requestId, user, reply);
    if (!ok) {
      return NextResponse.json({ error: 'request not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('user mismatch')) {
      return NextResponse.json({ error: 'user mismatch' }, { status: 403 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
