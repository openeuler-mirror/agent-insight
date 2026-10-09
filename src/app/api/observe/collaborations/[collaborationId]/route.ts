import { collaborationHandlers } from '@/lib/collaboration/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ collaborationId: string }> }) {
    return collaborationHandlers.graph(request, (await context.params).collaborationId);
}
