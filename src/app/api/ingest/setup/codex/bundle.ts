import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

const BUNDLE_FILES = [
  ['codex/codex-trace-core.cjs', ['codex', 'codex-trace-core.cjs']],
  ['codex/config-core.cjs', ['codex', 'config-core.cjs']],
  ['codex/hook-handler.cjs', ['codex', 'hook-handler.cjs']],
  ['codex/relay.cjs', ['codex', 'relay.cjs']],
  ['codex/install.cjs', ['codex', 'install.cjs']],
  ['codex/uninstall.cjs', ['codex', 'uninstall.cjs']],
  ['codex/self-check.cjs', ['codex', 'self-check.cjs']],
  ['codex/build-vsix.cjs', ['codex', 'build-vsix.cjs']],
  ['codex/vscode-extension/package.json', ['codex', 'vscode-extension', 'package.json']],
  ['codex/vscode-extension/extension.cjs', ['codex', 'vscode-extension', 'extension.cjs']],
  ['codex/vscode-extension/ide-trace-core.cjs', ['codex', 'vscode-extension', 'ide-trace-core.cjs']],
  ['codex/vscode-extension/extension.vsixmanifest', ['codex', 'vscode-extension', 'extension.vsixmanifest']],
  ['codex/vscode-extension/[Content_Types].xml', ['codex', 'vscode-extension', '[Content_Types].xml']],
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

export function codexCollectorBundle(root = process.cwd()): { buffer: Buffer; sha256: string } {
  const collectorRoot = path.join(root, 'scripts', 'agent-trace-collectors');
  const sources = BUNDLE_FILES.map(([archivePath, sourceParts]) => {
    const sourcePath = path.join(collectorRoot, ...sourceParts);
    const metadata = lstatSync(sourcePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Invalid Codex collector bundle source: ${archivePath}`);
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
