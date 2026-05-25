import { NextResponse } from 'next/server';
import { deleteAgentDataset, findAgentDataset } from '@/server/agent_datasets_storage';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const user = (searchParams.get('user') || '').trim();
    if (!user || !id?.trim()) {
      return NextResponse.json({ error: 'user and id are required' }, { status: 400 });
    }

    const dataset = await findAgentDataset(user, id.trim());
    if (!dataset) {
      return NextResponse.json({ error: 'dataset not found' }, { status: 404 });
    }

    return NextResponse.json(dataset);
  } catch (error) {
    console.error('agent-datasets [id] GET error:', error);
    return NextResponse.json({ error: 'failed to load dataset' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const user = (searchParams.get('user') || '').trim();
    const idTrim = id?.trim() || '';
    if (!user || !idTrim) {
      return NextResponse.json({ error: 'user and id are required' }, { status: 400 });
    }

    const removed = await deleteAgentDataset(user, idTrim);
    if (!removed) {
      return NextResponse.json({ error: 'dataset not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('agent-datasets [id] DELETE error:', error);
    return NextResponse.json({ error: 'failed to delete dataset' }, { status: 500 });
  }
}
