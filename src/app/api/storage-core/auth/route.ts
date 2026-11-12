import { handleCoreAuth } from '@/lib/storage-core/server';
import { isStorageCoreEnabled } from '@/lib/storage-core/mode';

function handle(request: Request): Promise<Response> | Response {
  if (!isStorageCoreEnabled()) return Response.json({ error: 'Storage core is not enabled' }, { status: 404 });
  return handleCoreAuth(request);
}
export const GET = handle;
export const POST = handle;
export const DELETE = handle;
