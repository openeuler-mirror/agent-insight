import { collaborationHandlers } from '@/lib/collaboration/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = collaborationHandlers.report;

export async function OPTIONS() {
    return new Response(null, {
        status: 204,
        headers: { 'Access-Control-Allow-Headers': 'Content-Type, x-witty-api-key' },
    });
}
