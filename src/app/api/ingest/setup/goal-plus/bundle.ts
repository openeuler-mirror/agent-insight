import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

const BUNDLE_FILES = [
  ['goal-plus/goal-plus-collector.cjs', ['goal-plus', 'goal-plus-collector.cjs']],
  ['goal-plus/install.cjs', ['goal-plus', 'install.cjs']],
  ['goal-plus/uninstall.cjs', ['goal-plus', 'uninstall.cjs']],
  ['goal-plus/lib/gp-snapshot-parser.cjs', ['goal-plus', 'lib', 'gp-snapshot-parser.cjs']],
  ['goal-plus/lib/pi-native-parser.cjs', ['goal-plus', 'lib', 'pi-native-parser.cjs']],
  ['goal-plus/lib/semantic-spool.cjs', ['goal-plus', 'lib', 'semantic-spool.cjs']],
  ['goal-plus/lib/source-registry.cjs', ['goal-plus', 'lib', 'source-registry.cjs']],
  ['shared/trace-transport.cjs', ['shared', 'trace-transport.cjs']],
  ['shared/pi-trace-helpers.cjs', ['shared', 'pi-trace-helpers.cjs']],
] as const;

const ZIP_TIMESTAMP = new Date(1980, 0, 1, 0, 0, 0);
let cached: { root: string; sourceDigest: string; buffer: Buffer; sha256: string } | undefined;

export function goalPlusCollectorBundle(root = process.cwd()) {
  const collectorRoot = path.join(root, 'scripts', 'agent-trace-collectors');
  const sources = BUNDLE_FILES.map(([archivePath, sourceParts]) => {
    const sourcePath = path.join(collectorRoot, ...sourceParts);
    const stat = lstatSync(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid Goal Plus bundle source: ${archivePath}`);
    return { archivePath, content: readFileSync(sourcePath) };
  });
  const digest = createHash('sha256');
  for (const source of sources) digest.update(source.archivePath).update('\0').update(source.content).update('\0');
  const sourceDigest = digest.digest('hex');
  if (cached?.root === root && cached.sourceDigest === sourceDigest) return cached;
  const archive = new AdmZip();
  for (const source of sources) {
    const entry = archive.addFile(source.archivePath, source.content);
    entry.header.time = ZIP_TIMESTAMP;
  }
  const buffer = archive.toBuffer();
  cached = { root, sourceDigest, buffer, sha256: createHash('sha256').update(buffer).digest('hex') };
  return cached;
}
