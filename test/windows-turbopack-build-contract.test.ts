import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const productionExtensions = new Set(['.cjs', '.js', '.mjs', '.ts', '.tsx']);
const unsafeChildProcessImport = /(?:from\s+|import\s*\(|require\s*\()\s*['"]node:child_process['"]/;

function listProductionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const sourcePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listProductionSources(sourcePath);
    return productionExtensions.has(path.extname(entry.name)) ? [sourcePath] : [];
  });
}

test('production source avoids Windows-unsafe Turbopack child_process chunk names', () => {
  const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
  const violations = listProductionSources(sourceRoot)
    .filter((sourcePath) => unsafeChildProcessImport.test(readFileSync(sourcePath, 'utf8')))
    .map((sourcePath) => path.relative(sourceRoot, sourcePath));

  assert.deepEqual(violations, []);
});
