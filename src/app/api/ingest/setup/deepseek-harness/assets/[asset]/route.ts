import { NextResponse } from 'next/server';

import { deepSeekHarnessPluginFile } from '../../files';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ asset: string }> },
) {
  try {
    const { asset } = await params;
    const file = deepSeekHarnessPluginFile(asset);
    if (!file) {
      return NextResponse.json({ error: 'DeepSeek Harness plugin file not found' }, { status: 404 });
    }
    return new NextResponse(new Uint8Array(file.content), {
      headers: {
        'Content-Type': file.contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Agent-Insight-SHA256': file.sha256,
      },
    });
  } catch {
    return NextResponse.json(
      { error: 'DeepSeek Harness plugin files are unavailable' },
      { status: 500 },
    );
  }
}
