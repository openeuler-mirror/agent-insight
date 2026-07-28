import AdmZip from 'adm-zip';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let cachedArchive: Buffer | undefined;

function collectorRoot(): string {
    const candidates = [
        path.join(process.cwd(), 'scripts', 'llamaindex_extension'),
        path.join(process.cwd(), '..', '..', 'scripts', 'llamaindex_extension'),
    ];
    const root = candidates.find((candidate) =>
        existsSync(path.join(candidate, 'src', 'agent_insight_llamaindex', '__init__.py')),
    );
    if (!root) {
        throw new Error('Bundled LlamaIndex collector is missing');
    }
    return root;
}

function addDirectory(zip: AdmZip, root: string, current: string): void {
    for (const name of readdirSync(current).sort()) {
        if (name === '__pycache__' || name === '.pytest_cache' || name.endsWith('.pyc')) continue;
        const absolute = path.join(current, name);
        const relative = path.relative(root, absolute).replaceAll(path.sep, '/');
        const metadata = lstatSync(absolute);
        if (metadata.isSymbolicLink()) continue;
        if (metadata.isDirectory()) {
            addDirectory(zip, root, absolute);
        } else if (metadata.isFile()) {
            zip.addLocalFile(absolute, path.posix.dirname(relative));
        }
    }
}

function collectorArchive(): Buffer {
    if (cachedArchive) return cachedArchive;
    const root = collectorRoot();
    const sourceRoot = path.join(root, 'src');
    const packageRoot = path.join(sourceRoot, 'agent_insight_llamaindex');
    const readme = path.join(root, 'README.md');
    const zip = new AdmZip();
    if (!existsSync(packageRoot)) throw new Error('Missing bundled collector package');
    if (lstatSync(packageRoot).isSymbolicLink()) throw new Error('Refusing bundled collector symlink');
    addDirectory(zip, sourceRoot, packageRoot);
    if (existsSync(readme) && lstatSync(readme).isFile()) zip.addLocalFile(readme);
    cachedArchive = zip.toBuffer();
    return cachedArchive;
}

export async function GET(): Promise<NextResponse> {
    try {
        return new NextResponse(new Uint8Array(collectorArchive()), {
            status: 200,
            headers: {
                'Content-Type': 'application/zip',
                'Content-Disposition': 'attachment; filename="agent-insight-llamaindex.zip"',
                'Cache-Control': 'private, no-store',
            },
        });
    } catch (error) {
        console.error('Unable to create bundled LlamaIndex collector archive:', error);
        return new NextResponse('Bundled LlamaIndex collector is unavailable', { status: 500 });
    }
}
