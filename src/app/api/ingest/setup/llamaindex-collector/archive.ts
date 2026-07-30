import AdmZip from 'adm-zip';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';

let cachedArchive: { root: string; signature: string; buffer: Buffer } | undefined;

function collectorRoot(): string {
    const candidates = [
        path.join(process.cwd(), 'scripts', 'llamaindex_extension'),
        path.join(process.cwd(), '..', '..', 'scripts', 'llamaindex_extension'),
    ];
    const root = candidates.find((candidate) =>
        existsSync(path.join(candidate, 'src', 'agent_insight_llamaindex', '__init__.py')),
    );
    if (!root) throw new Error('Bundled LlamaIndex collector is missing');
    return root;
}

function shouldSkip(name: string): boolean {
    return name === '__pycache__' || name === '.pytest_cache' || name.endsWith('.pyc');
}

function addDirectory(zip: AdmZip, root: string, current: string): void {
    for (const name of readdirSync(current).sort()) {
        if (shouldSkip(name)) continue;
        const absolute = path.join(current, name);
        const relative = path.relative(root, absolute).replaceAll(path.sep, '/');
        const metadata = lstatSync(absolute);
        if (metadata.isSymbolicLink()) continue;
        if (metadata.isDirectory()) addDirectory(zip, root, absolute);
        else if (metadata.isFile()) zip.addLocalFile(absolute, path.posix.dirname(relative));
    }
}

function appendSourceSignature(root: string, current: string, parts: string[]): void {
    for (const name of readdirSync(current).sort()) {
        if (shouldSkip(name)) continue;
        const absolute = path.join(current, name);
        const metadata = lstatSync(absolute);
        if (metadata.isSymbolicLink()) continue;
        if (metadata.isDirectory()) {
            appendSourceSignature(root, absolute, parts);
        } else if (metadata.isFile()) {
            const relative = path.relative(root, absolute).replaceAll(path.sep, '/');
            parts.push(`${relative}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`);
        }
    }
}

function collectorSourceSignature(root: string, packageRoot: string, readme: string): string {
    const parts: string[] = [];
    appendSourceSignature(root, packageRoot, parts);
    if (existsSync(readme)) {
        const metadata = lstatSync(readme);
        if (metadata.isFile() && !metadata.isSymbolicLink()) {
            parts.push(`README.md:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`);
        }
    }
    return parts.join('|');
}

export function collectorArchive(
    root = collectorRoot(),
    useCache = process.env.NODE_ENV === 'production',
): Buffer {
    const sourceRoot = path.join(root, 'src');
    const packageRoot = path.join(sourceRoot, 'agent_insight_llamaindex');
    const readme = path.join(root, 'README.md');
    if (!existsSync(packageRoot)) throw new Error('Missing bundled collector package');
    if (lstatSync(packageRoot).isSymbolicLink()) throw new Error('Refusing bundled collector symlink');
    const signature = collectorSourceSignature(root, packageRoot, readme);
    if (useCache && cachedArchive?.root === root && cachedArchive.signature === signature) {
        return cachedArchive.buffer;
    }
    const zip = new AdmZip();
    addDirectory(zip, sourceRoot, packageRoot);
    if (existsSync(readme) && lstatSync(readme).isFile()) zip.addLocalFile(readme);
    const buffer = zip.toBuffer();
    if (useCache) cachedArchive = { root, signature, buffer };
    return buffer;
}
