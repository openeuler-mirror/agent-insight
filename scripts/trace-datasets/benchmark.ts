import fs from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { COVERAGE_POLICY as POLICY, LEGACY_POLICY, lexicalFeatures, signature, sample, hash, type Candidate } from '../../src/lib/trace-datasets/sampling';
const policy = process.argv.includes('--legacy') ? LEGACY_POLICY : POLICY;
const measurements = [];
for (const n of [1000, 5000, 10000]) {
  const start = performance.now();
  const pool: Candidate[] = Array.from({ length: n }, (_, i) => {
    const input = `Explain the behavior of ${createHash('sha256').update(String(i)).digest('hex')} in a concurrent system. 描述测试任务${i}的执行结果。`;
    return { key: hash([input, 'answer']), inputKey: hash([input]), task: ['coding', 'information_lookup', 'unknown'][i % 3], signature: signature(input), lexical: policy.version === POLICY.version ? lexicalFeatures(input) : undefined, paths: [{ key: String(i), cells: i % 3 ? [`tool:${i % 17}`, `retry:${i % 2}`] : [], knownDimensions: i % 3 ? 2 : 0 }] };
  });
  const signatureMs = performance.now() - start;
  for (const k of [20, 100, 500]) {
    const selectionStart = performance.now(), result = sample(pool, k, policy);
    measurements.push({ n, k, signatureMs, selectionMs: performance.now() - selectionStart, count: result.selected.length, rss: process.memoryUsage().rss });
  }
}
console.log(JSON.stringify({ policy, hardware: { cpu: os.cpus()[0].model, cores: os.cpus().length, totalMemory: os.totalmem(), node: process.version }, evidence: 'Synthetic feasibility benchmark; not public-data effectiveness or behavior benefit evidence.', measurements }, null, 2));
