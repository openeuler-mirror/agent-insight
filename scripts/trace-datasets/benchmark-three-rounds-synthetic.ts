import os from 'node:os';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { COVERAGE_POLICY, hash, lexicalFeatures, signature, sample, type Candidate } from '../../src/lib/trace-datasets/sampling';
const method = process.argv[2], long = process.argv.includes('--long');
if (!['v5','v65','v66','v67'].includes(method)) throw new Error('INVALID_METHOD');
const modules = ['budgeted-fast', 'answer-consensus', 'budgeted-agreement'];
const index = ['v65', 'v66', 'v67'].indexOf(method);
const sampler = index >= 0 ? require(`../../src/lib/trace-datasets/sampling/${modules[index]}`) : undefined;
const policy = method === 'v5' ? COVERAGE_POLICY : sampler[method === 'v65' ? 'FAST_POLICY' : method === 'v66' ? 'CONSENSUS_POLICY' : 'AGREEMENT_POLICY'];
const measurements = [];
const n = long ? 1000 : 10000;
const start = performance.now();
const code = createHash('sha256').update(fs.readFileSync('src/lib/trace-datasets/sampling/index.ts')).digest('hex');
const cacheKey = hash(['three-rounds-synthetic-fixture-1', code, long]);
const cacheFile = `${os.tmpdir()}/trace-three-rounds-synthetic-${cacheKey}.json`;
let pool: Candidate[], coldFeatureMs: number;
if (fs.existsSync(cacheFile)) {
  const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  if (cached.key !== cacheKey || hash(cached.rows) !== cached.sha256) throw new Error('CACHE_CORRUPT');
  pool = cached.rows.map((row: any) => ({ ...row, signature: Uint32Array.from(row.signature) }));
  coldFeatureMs = cached.coldFeatureMs;
} else {
  pool = Array.from({ length: n }, (_, i) => {
  const input = `Explain the behavior of ${createHash('sha256').update(String(i)).digest('hex')} in a concurrent system. 描述测试任务${i}的执行结果。` + (long ? Array.from({ length: 2048 }, (_, j) => ` term${(i * 13 + j) % 17000}`).join('') : '');
  return { key: hash([input, 'answer']), inputKey: hash([input]), task: ['coding', 'information_lookup', 'unknown'][i % 3], signature: signature(input), lexical: lexicalFeatures(input), paths: [{ key: String(i), cells: i % 3 ? [`tool:${i % 17}`, `retry:${i % 2}`] : [], knownDimensions: i % 3 ? 2 : 0 }] };
});
  coldFeatureMs = performance.now() - start;
  const rows = pool.map(row => ({ ...row, signature: [...row.signature] }));
  fs.writeFileSync(cacheFile, JSON.stringify({ key: cacheKey, rows, sha256: hash(rows), coldFeatureMs }));
}
if (process.argv.includes('--prepare')) { console.log(JSON.stringify({ cacheKey, coldFeatureMs, n })); process.exit(0); }
const featureMs = performance.now() - start;
const answers = new Map(pool.map(c => [c.key, 'answer']));
const rssAfterFeatures = process.memoryUsage().rss, highWaterAfterFeaturesKiB = process.resourceUsage().maxRSS;
for (const k of [20, 100, 500]) {
  const selectionStart = performance.now();
  const result = method === 'v5' ? sample(pool, k, COVERAGE_POLICY) : method === 'v65' ? sampler.fastSample(pool, k) : method === 'v66' ? sampler.consensusSample(pool, answers, k) : sampler.agreementSample(pool, answers, k);
  measurements.push({ n, k, featureMs, selectionMs: performance.now() - selectionStart, count: result.selected.length, rss: process.memoryUsage().rss, maxRssKiB: process.resourceUsage().maxRSS, additionalHighWaterKiB: Math.max(0, process.resourceUsage().maxRSS - highWaterAfterFeaturesKiB), optimization: 'optimization' in result ? result.optimization : undefined });
}
const codeHashes = Object.fromEntries(['src/lib/trace-datasets/sampling/index.ts', ...modules.slice(0,index+1).map(n => `src/lib/trace-datasets/sampling/${n}.ts`), 'scripts/trace-datasets/benchmark-three-rounds-synthetic.ts'].map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
console.log(JSON.stringify({ policy, long, coldFeatureMs, cacheKey, codeHashes, rssAfterFeatures, highWaterAfterFeaturesKiB, hardware: { cpu: os.cpus()[0].model, cores: os.cpus().length, totalMemory: os.totalmem(), node: process.version }, evidence: 'Isolated synthetic pure-function run; checksum-verified temporary fixture features; cold generation and cache load work reported separately; additionalHighWaterKiB is cumulative over K=20/100/500, not exact peak allocation. Not Worker concurrency or end-to-end UI evidence.', measurements }, null, 2));
