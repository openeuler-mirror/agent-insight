import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

const BUNDLE_FILES = [
  ['pi-agent/package.json', ['pi-agent', 'package.json']],
  ['pi-agent/extensions/pi-agent-insight.ts', ['pi-agent', 'extensions', 'pi-agent-insight.ts']],
  ['pi-agent/lib/pi-trace-core.cjs', ['pi-agent', 'lib', 'pi-trace-core.cjs']],
  ['pi-agent/scripts/self-check.cjs', ['pi-agent', 'scripts', 'self-check.cjs']],
  ['pi-agent/scripts/uninstall.cjs', ['pi-agent', 'scripts', 'uninstall.cjs']],
  ['pi-agent/install.cjs', ['pi-agent', 'install.cjs']],
  ['shared/trace-transport.cjs', ['shared', 'trace-transport.cjs']],
] as const;

const ZIP_TIMESTAMP = new Date(1980, 0, 1, 0, 0, 0);

type CachedBundle = {
  root: string;
  sourceDigest: string;
  buffer: Buffer;
  sha256: string;
};

let cachedBundle: CachedBundle | undefined;

export function piAgentBundle(root = process.cwd()): { buffer: Buffer; sha256: string } {
  const collectorRoot = path.join(root, 'scripts', 'agent-trace-collectors');
  const sources = BUNDLE_FILES.map(([archivePath, sourceParts]) => {
    const sourcePath = path.join(collectorRoot, ...sourceParts);
    const metadata = lstatSync(sourcePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Invalid Pi Agent bundle source: ${archivePath}`);
    }
    return { archivePath, content: readFileSync(sourcePath) };
  });
  const sourceHash = createHash('sha256');
  for (const source of sources) {
    sourceHash.update(source.archivePath);
    sourceHash.update('\0');
    sourceHash.update(source.content);
    sourceHash.update('\0');
  }
  const sourceDigest = sourceHash.digest('hex');
  if (cachedBundle?.root === root && cachedBundle.sourceDigest === sourceDigest) {
    return cachedBundle;
  }

  const archive = new AdmZip();
  for (const source of sources) {
    const entry = archive.addFile(source.archivePath, source.content);
    entry.header.time = ZIP_TIMESTAMP;
  }
  const buffer = archive.toBuffer();
  cachedBundle = {
    root,
    sourceDigest,
    buffer,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
  return cachedBundle;
}
