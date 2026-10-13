import os from 'node:os';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { COVERAGE_POLICY, hash, lexicalFeatures, signature, sample, type Candidate } from '../../src/lib/trace-datasets/sampling';
import { BUDGETED_POLICY, budgetedSample } from '../../src/lib/trace-datasets/sampling/budgeted';
import { REFINED_POLICY, refinedSample } from '../../src/lib/trace-datasets/sampling/budgeted-refined';
const modern = !process.argv.includes('--v5'), long = process.argv.includes('--long');
const policy = modern ? (process.argv.includes('--v6') ? BUDGETED_POLICY : REFINED_POLICY) : COVERAGE_POLICY, measurements = [];
const n = long ? 1000 : 10000;
const start = performance.now();
const pool: Candidate[] = Array.from({ length: n }, (_, i) => {
  const input = `Explain the behavior of ${createHash('sha256').update(String(i)).digest('hex')} in a concurrent system. 描述测试任务${i}的执行结果。` + (long ? Array.from({ length: 2048 }, (_, j) => ` term${(i * 13 + j) % 17000}`).join('') : '');
  return { key: hash([input, 'answer']), inputKey: hash([input]), task: ['coding', 'information_lookup', 'unknown'][i % 3], signature: signature(input), lexical: lexicalFeatures(input), paths: [{ key: String(i), cells: i % 3 ? [`tool:${i % 17}`, `retry:${i % 2}`] : [], knownDimensions: i % 3 ? 2 : 0 }] };
});
const featureMs = performance.now() - start;
const rssAfterFeatures = process.memoryUsage().rss, highWaterAfterFeaturesKiB = process.resourceUsage().maxRSS;
for (const k of [20, 100, 500]) {
  const selectionStart = performance.now();
  const result = modern ? (process.argv.includes('--v6') ? budgetedSample(pool, k) : refinedSample(pool, k)) : sample(pool, k, COVERAGE_POLICY);
  measurements.push({ n, k, featureMs, selectionMs: performance.now() - selectionStart, count: result.selected.length, rss: process.memoryUsage().rss, maxRssKiB: process.resourceUsage().maxRSS, additionalHighWaterKiB: Math.max(0, process.resourceUsage().maxRSS - highWaterAfterFeaturesKiB), optimization: 'optimization' in result ? result.optimization : undefined });
}
const codeHashes = Object.fromEntries(['src/lib/trace-datasets/sampling/index.ts', 'src/lib/trace-datasets/sampling/budgeted.ts', 'src/lib/trace-datasets/sampling/budgeted-refined.ts', 'scripts/trace-datasets/benchmark-refined.ts'].map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
console.log(JSON.stringify({ policy, long, codeHashes, rssAfterFeatures, highWaterAfterFeaturesKiB, hardware: { cpu: os.cpus()[0].model, cores: os.cpus().length, totalMemory: os.totalmem(), node: process.version }, evidence: 'Isolated synthetic pure-function run; feature/signature work included separately; additionalHighWaterKiB is cumulative over K=20/100/500, not exact peak allocation. Not Worker concurrency or end-to-end UI evidence.', measurements }, null, 2));
