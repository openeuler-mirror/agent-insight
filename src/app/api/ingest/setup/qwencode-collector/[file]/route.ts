import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';

// The curl installer needs the collector as a small group of ES modules.  Keep
// this endpoint explicitly allow-listed so it cannot expose arbitrary files
// from the Agent Insight installation.
const collectorFiles = new Set([
  'configure.mjs',
  'install.mjs',
]);

export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  if (!collectorFiles.has(file)) {
    return NextResponse.json({ error: 'Collector file not found' }, { status: 404 });
  }

  const filePath = path.join(process.cwd(), 'scripts', 'qwencode-collector', file);
  try {
    const content = await readFile(filePath, 'utf8');
    return new NextResponse(content, {
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Qwen Code collector is unavailable' }, { status: 404 });
  }
}
