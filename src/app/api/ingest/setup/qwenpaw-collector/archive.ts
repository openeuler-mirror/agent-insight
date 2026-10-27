import AdmZip from 'adm-zip';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';

let cachedArchive: { root: string; signature: string; buffer: Buffer } | undefined;

function collectorRoot(): string {
    const candidates = [
        path.join(process.cwd(), 'scripts', 'qwenpaw-collector'),
        path.join(process.cwd(), '..', '..', 'scripts', 'qwenpaw-collector'),
    ];
    const root = candidates.find((candidate) =>
        existsSync(path.join(candidate, 'pyproject.toml')) &&
        existsSync(path.join(candidate, 'qwenpaw_insight', '__init__.py')),
    );
    if (!root) throw new Error('Bundled QwenPaw collector is missing');
    return root;
}

function shouldSkip(name: string): boolean {
    return name === '__pycache__' ||
        name === '.pytest_cache' ||
        name === 'build' ||
        name === 'dist' ||
        name.endsWith('.pyc') ||
        name.endsWith('.egg-info');
}

function addDirectory(zip: AdmZip, root: string, current: string): void {
    for (const name of readdirSync(current).sort()) {
        if (shouldSkip(name)) continue;
        const absolute = path.join(current, name);
        const metadata = lstatSync(absolute);
        if (metadata.isSymbolicLink()) continue;
        const relative = path.relative(root, absolute).replaceAll(path.sep, '/');
        if (metadata.isDirectory()) {
            addDirectory(zip, root, absolute);
        } else if (metadata.isFile()) {
            zip.addLocalFile(absolute, path.posix.dirname(relative));
        }
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

function collectorSourceSignature(root: string): string {
    const parts: string[] = [];
    appendSourceSignature(root, root, parts);
    return parts.join('|');
}

export function qwenpawCollectorArchive(
    root = collectorRoot(),
    useCache = process.env.NODE_ENV === 'production',
): Buffer {
    if (lstatSync(root).isSymbolicLink()) throw new Error('Refusing bundled collector symlink');
    const signature = collectorSourceSignature(root);
    if (useCache && cachedArchive?.root === root && cachedArchive.signature === signature) {
        return cachedArchive.buffer;
    }

    const zip = new AdmZip();
    addDirectory(zip, root, root);
    const buffer = zip.toBuffer();
    if (useCache) cachedArchive = { root, signature, buffer };
    return buffer;
}
