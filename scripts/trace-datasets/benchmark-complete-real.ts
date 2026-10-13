import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { COVERAGE_POLICY, hash, normalizeText, lexicalFeatures, taskType, sample, type Candidate } from '../../src/lib/trace-datasets/sampling';
import { NEIGHBORHOOD_POLICY, neighborhoodSample } from '../../src/lib/trace-datasets/sampling/budgeted-neighborhood';
import { COMPLETE_POLICY, completeSample } from '../../src/lib/trace-datasets/sampling/budgeted-complete';

const [dataRoot, baselineRoot, resultsRoot, name, method] = process.argv.slice(2);
assert.ok(['v5', 'v63', 'v64'].includes(method));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const files = ['src/lib/trace-datasets/sampling/index.ts', 'src/lib/trace-datasets/sampling/budgeted-neighborhood.ts', 'src/lib/trace-datasets/sampling/budgeted-complete.ts', 'scripts/trace-datasets/benchmark-complete-real.ts'];
const codeHashes = Object.fromEntries(files.map(f => [f, sha(fs.readFileSync(f))]));
const baseline = JSON.parse(fs.readFileSync(path.join(baselineRoot, `${name}.json`), 'utf8'));
const frozenBytes = fs.readFileSync(path.join(resultsRoot, `${name}.json`)), frozen = JSON.parse(frozenBytes.toString());
assert.ok(frozen.finishedAt);
const data = fs.readFileSync(path.join(dataRoot, baseline.source.file));
assert.equal(sha(data), baseline.source.sha256); assert.equal(sha(data), frozen.dataSha256);
for (const file of files.slice(0, 3)) assert.equal(codeHashes[file], frozen.plan.codeHashes[file]);
const started = performance.now(), strata = new Map<string, Map<string, { input: string; inputKey: string }>>();
for (const row of JSON.parse(data.toString())) {
  if (!row.input.trim() || !row.reference_output.trim()) continue;
  const stratum = name === 'SummarizeFeedback' ? `${row.domain}/${row.split}` : 'all';
  if (!strata.has(stratum)) strata.set(stratum, new Map());
  const input = normalizeText(row.input), key = hash([input, normalizeText(row.reference_output)]);
  strata.get(stratum)!.set(key, { input, inputKey: hash([input]) });
}
const chosen = new Map<string, any>();
for (const e of baseline.experiments) {
  const key = `${e.stratum}:${e.population}`, old = chosen.get(key);
  if (!old || Math.abs(e.requestedPool - 5000) < Math.abs(old.requestedPool - 5000)) chosen.set(key, e);
}
const used = new Map<string, string>();
for (const e of chosen.values()) for (const key of e.poolKeys) {
  const row = strata.get(e.stratum)!.get(key)!; used.set(row.inputKey, row.input);
}
const cacheKey = hash([codeHashes[files[0]], 42, [...used.keys()].sort()]);
const envelope = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'agent-insight-research-signatures', `${cacheKey}.json`), 'utf8'));
assert.equal(envelope.key, cacheKey); assert.equal(hash(envelope.rows), envelope.sha256);
const signatures = new Map<string, Uint32Array>(envelope.rows.map(([key, values]: [string, number[]]) => [key, Uint32Array.from(values)]));
const lexical = new Map([...used].map(([key, input]) => [key, lexicalFeatures(input)]));
const preparationMs = performance.now() - started, measurements = [];
for (const e of chosen.values()) {
  if (e.population !== 'all') continue;
  const candidates: Candidate[] = e.poolKeys.map((key: string) => {
    const row = strata.get(e.stratum)!.get(key)!;
    return { key, inputKey: row.inputKey, task: taskType(row.input), lexical: lexical.get(row.inputKey)!, signature: signatures.get(row.inputKey)!, paths: [{ key, cells: [], knownDimensions: 0 }] };
  });
  const before = process.resourceUsage().maxRSS, start = performance.now();
  const result = method === 'v5' ? sample(candidates, 100, COVERAGE_POLICY) : method === 'v63' ? neighborhoodSample(candidates, 100, NEIGHBORHOOD_POLICY) : completeSample(candidates, 100, COMPLETE_POLICY);
  const selectionMs = performance.now() - start, after = process.resourceUsage().maxRSS;
  const original = frozen.scenarios.find((s: any) => s.stratum === e.stratum && s.population === e.population && s.seed === 42 && s.k === 100);
  assert.deepEqual(result.selected.map(s => s.key), original.methods[method === 'v5' ? 'C' : method === 'v63' ? 'V63' : 'V64'].selected);
  measurements.push({ stratum: e.stratum, population: e.population, n: candidates.length, k: 100, seed: 42, selectionMs, maxRssKiB: after, additionalHighWaterKiB: Math.max(0, after - before), idsMatchFrozen: true });
}
console.log(JSON.stringify({ name, method, codeHashes, sourceSha256: sha(data), resultsSha256: sha(frozenBytes), preparationMs, hardware: { cpu: os.cpus()[0].model, cores: os.cpus().length, totalMemory: os.totalmem(), node: process.version }, measurements, limitation: 'One process per dataset and method, K100 seed42; signatures use checksum-verified temporary research cache. Summary strata share a process. RSS increment is a high-water proxy, not exact allocations. Not Worker concurrency or end-to-end UI.' }, null, 2));
