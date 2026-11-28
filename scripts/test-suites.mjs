import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const modules = ['observability', 'evaluation', 'skills', 'reliability', 'platform'];

function testFiles(directory = 'test') {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true })
    .filter(entry => !entry.name.startsWith('.'))
    .flatMap(entry => {
      const file = `${directory}/${entry.name}`;
      return entry.isDirectory() ? testFiles(file) : entry.isFile() && file.endsWith('.test.ts') ? [file] : [];
    }).sort();
}

export function validateSuites(suites, files) {
  if (!suites || typeof suites !== 'object' || Object.keys(suites).length !== modules.length
    || modules.some(module => !Array.isArray(suites[m]))) throw new Error('Invalid module inventory');
  const actual = new Set(files), seen = new Set();
  for (const m of modules) for (const file of suites[m]) {
    if (!actual.has(file)) throw new Error(`Stale test path: ${file}`);
    if (seen.has(file)) throw new Error(`Duplicate test path: ${file}`);
    seen.add(file);
  }
  const missing = files.filter(file => !seen.has(file));
  if (missing.length) throw new Error(`Unclassified tests: ${missing.join(', ')}`);
}

export function main(args) {
  const selected = new Set();
  let list = false, check = false, concurrency;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--module') {
      const target = args[++index];
      if (!modules.includes(target)) throw new Error(`Unknown module: ${target}. Choose ${modules.join(', ')}`);
      selected.add(target);
    } else if (arg === '--list') list = true;
    else if (arg === '--check') check = true;
    else if (arg === '--concurrency') {
      const value = args[++index];
      if (!/^[1-9]\d*$/.test(value || '')) throw new Error('Concurrency must be a positive integer');
      concurrency = Number(value);
      if (!Number.isSafeInteger(concurrency)) throw new Error('Concurrency is too large');
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!check && !selected.size) throw new Error('Select --module <name> or use --check');
  const suites = JSON.parse(fs.readFileSync(path.join(root, 'test/suites.json'), 'utf8'));
  validateSuites(suites, testFiles());
  const files = [...selected].flatMap(module => suites[m]).sort();
  if (list) { console.log(files.join('\n'));return 0; }
  if (check) { console.log(modules.map(module => `${module}: ${suites[m].length}`).join('\n'));return 0; }
  const commands = [
    ['scripts/benchmark/generate-catalog.cjs'],
    ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'scripts/trae-collector/tsconfig.json'],
    ['--import', 'tsx', '--test', ...(concurrency ? [`--test-concurrency=${concurrency}`] : []), ...files],
  ];
  for (const command of commands) {
    const result = spawnSync(process.execPath, command, { cwd: root, env: process.env, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(error.message);process.exitCode = 1; }
}
