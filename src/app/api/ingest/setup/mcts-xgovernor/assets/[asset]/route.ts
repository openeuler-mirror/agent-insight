import { NextResponse } from 'next/server';

import { mctsXgovernorCollectorBundle } from '../../bundle';

export async function GET(_request: Request, context: { params: Promise<{ asset: string }> }) {
  const { asset } = await context.params;
  if (asset !== 'mcts-xgovernor-collector.zip') {
    return NextResponse.json({ error: 'Unknown MCTS xGovernor collector asset' }, { status: 404 });
  }
  try {
    const { buffer } = mctsXgovernorCollectorBundle();
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="mcts-xgovernor-collector.zip"',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return NextResponse.json({ error: 'MCTS xGovernor collector bundle is unavailable' }, { status: 500 });
  }
}
