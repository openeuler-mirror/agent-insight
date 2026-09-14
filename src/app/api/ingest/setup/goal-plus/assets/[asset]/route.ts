import { NextResponse } from 'next/server';
import { goalPlusCollectorBundle } from '../../bundle';

export async function GET(_request: Request, context: { params: Promise<{ asset: string }> }) {
  const { asset } = await context.params;
  if (asset !== 'goal-plus-collector.zip') return NextResponse.json({ error: 'Unknown Goal Plus collector asset' }, { status: 404 });
  try {
    const { buffer } = goalPlusCollectorBundle();
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="goal-plus-collector.zip"',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Goal Plus collector bundle is unavailable' }, { status: 500 });
  }
}
