import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { COVERAGE_POLICY as POLICY, LEGACY_POLICY, hash, normalizeText, signature, lexicalFeatures, lengthBucket, sample, taskType, type Candidate } from '../../src/lib/trace-datasets/sampling';

import { neighborhoodSample, NEIGHBORHOOD_POLICY, type NeighborhoodExperiment } from '../../src/lib/trace-datasets/sampling/budgeted-neighborhood';

const [dataRoot, baselineRoot, v5Root, v6Root, v61Root, v62Root, outputRoot, ...args] = process.argv.slice(2);
const smoke = args.includes('--smoke'), names = args.filter(n => n !== '--smoke');
if (!outputRoot) throw new Error('Usage: compare-neighborhood-v63.ts <data> <frozen-v4-results> <frozen-v5-results> <frozen-v6-results> <frozen-v61-results> <frozen-v62-results> <output> [dataset ...]');
fs.mkdirSync(outputRoot, { recursive: true });
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const seeds = smoke ? [42] : [42, 100, 101, 102, 103];
const variants: Record<string, NeighborhoodExperiment> = { FAST: { neighborhood: false }, V63: {} };
const sourceFiles = ['src/lib/trace-datasets/sampling/index.ts', 'src/lib/trace-datasets/sampling/budgeted.ts', 'src/lib/trace-datasets/sampling/budgeted-refined.ts', 'src/lib/trace-datasets/sampling/budgeted-exchange.ts', 'src/lib/trace-datasets/sampling/budgeted-neighborhood.ts', 'scripts/trace-datasets/compare-neighborhood-v63.ts'];
const codeHashes = Object.fromEntries(sourceFiles.map(file => [file, sha(fs.readFileSync(file))]));
const plan = { version: 'neighborhood-v63-comparison-1', policy: NEIGHBORHOOD_POLICY, seeds, primaryK: 100, sensitivityK: smoke ? [20] : [20, 500], sensitivitySeed: 42, budgetRatios: [1, 1.1, 1.2], variants, codeHashes, smoke,
  pool: 'exact frozen v4/v5 pools; nearest 5000 for every original stratum and population',
  limitations: 'Known regression data, not independent confirmation. No observed tool paths. Quality labels only after selection. Microsoft published numbers are external targets, not same-pool results.',
};
const planFile = path.join(outputRoot, 'plan.json');
if (fs.existsSync(planFile)) assert.deepEqual(JSON.parse(fs.readFileSync(planFile, 'utf8')), plan);
else fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
type Row = { input: string; reference_output: string; domain?: string; split?: string; category?: string; quality?: Record<string, number> };
type Pair = { input: string; key: string; inputKey: string; tokens: string[]; labels: Record<string, number[]>; category?: string };
const tokenize = (input: string) => input.toLowerCase().match(/\p{Script=Han}|[\p{L}\p{M}\p{N}]+/gu) || [];
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
function metrics(rows: Pair[]) {
  const vocabulary = new Set<string>(), prefix = new Set<string>(), labels: Record<string, number[]> = {}, buckets = [0, 0, 0, 0];
  for (const row of rows) {
    for (const t of row.tokens) vocabulary.add(t);
    for (const t of row.tokens.slice(0, 256)) prefix.add(t);
    buckets[lengthBucket(row.tokens.length)]++;
    for (const [key, scores] of Object.entries(row.labels)) (labels[key] ||= []).push(mean(scores));
  }
  return { count: rows.length, inputs: new Set(rows.map(r => r.inputKey)).size, vocabulary: vocabulary.size, prefix256: prefix.size, tokens: rows.reduce((n, r) => n + r.tokens.length, 0), meanInputChars: mean(rows.map(r => [...r.input].length)), buckets, nativeCategories: new Set(rows.map(r => r.category).filter(Boolean)).size, knownTasks: new Set(rows.map(r => taskType(r.input)).filter(t => t !== 'unknown')).size, quality: Object.fromEntries(Object.entries(labels).map(([key, scores]) => [key, { mean: mean(scores), labeled: scores.length }])) };
}
for (const name of names.length ? names : ['WildChat', 'Dolly', 'NoRobots', 'OASST2', 'ShareGPT4', 'UltraChat', 'HelpSteer2', 'SummarizeFeedback']) {
  const baselineData = fs.readFileSync(path.join(baselineRoot, `${name}.json`));
  const baseline = JSON.parse(baselineData.toString());
  const frozenV5Data = fs.readFileSync(path.join(v5Root, `${name}.json`));
  const frozenV5 = JSON.parse(frozenV5Data.toString());
  const v6Data = fs.readFileSync(path.join(v6Root, `${name}.json`)), v6 = JSON.parse(v6Data.toString());
  const v61Data = fs.readFileSync(path.join(v61Root, `${name}.json`)), v61 = JSON.parse(v61Data.toString());
  const v62Data = fs.readFileSync(path.join(v62Root, `${name}.json`)), v62 = JSON.parse(v62Data.toString());
  assert.ok(v62.finishedAt);
  assert.equal(v62.plan.codeHashes[sourceFiles[3]], codeHashes[sourceFiles[3]]);
  assert.ok(v61.finishedAt);
  assert.equal(v61.plan.codeHashes[sourceFiles[2]], codeHashes[sourceFiles[2]]);
  assert.ok(v6.finishedAt);
  assert.equal(v6.plan.codeHashes[sourceFiles[1]], codeHashes[sourceFiles[1]]);
  assert.ok(frozenV5.finishedAt);
  assert.equal(frozenV5.codeSha256, codeHashes[sourceFiles[0]]);
  assert.ok(baseline.finishedAt);
  const data = fs.readFileSync(path.join(dataRoot, baseline.source.file));
  assert.equal(sha(data), baseline.source.sha256);
  const strata = new Map<string, Map<string, Pair>>();
  for (const raw of JSON.parse(data.toString()) as Row[]) {
    if (!raw.input.trim() || !raw.reference_output.trim()) continue;
    const input = normalizeText(raw.input), answer = normalizeText(raw.reference_output), key = hash([input, answer]);
    const stratum = name === 'SummarizeFeedback' ? `${raw.domain}/${raw.split}` : 'all';
    let pairs = strata.get(stratum); if (!pairs) { pairs = new Map(); strata.set(stratum, pairs); }
    let pair = pairs.get(key);
    if (!pair) { pair = { input, key, inputKey: hash([input]), tokens: tokenize(input), labels: {}, category: raw.category }; pairs.set(key, pair); }
    for (const [axis, score] of Object.entries(raw.quality || {})) if (Number.isFinite(score)) (pair.labels[axis] ||= []).push(score);
  }
  const chosen = new Map<string, any>();
  for (const e of baseline.experiments) {
    const key = `${e.stratum}:${e.population}`, old = chosen.get(key);
    if (!old || Math.abs(e.requestedPool - 5000) < Math.abs(old.requestedPool - 5000)) chosen.set(key, e);
  }
  const used = new Map<string, Pair>();
  for (const e of chosen.values()) for (const key of e.poolKeys) { const row = strata.get(e.stratum)!.get(key)!; assert.ok(row); used.set(row.inputKey, row); }
  const lexicalStart = performance.now();
  const lexical = new Map([...used].map(([key, row]) => [key, lexicalFeatures(row.input)]));
  const lexicalMs = performance.now() - lexicalStart;
  const report: any = { name, plan, baselineSha256: sha(baselineData), v5Sha256: sha(frozenV5Data), v6Sha256: sha(v6Data), v61Sha256: sha(v61Data), v62Sha256: sha(v62Data), dataSha256: sha(data), startedAt: new Date().toISOString(), lexicalMsShared: lexicalMs, scenarios: [] };
  for (const seed of seeds) {
    const signatureStart = performance.now();
    const cacheRoot = path.join(os.tmpdir(), 'agent-insight-research-signatures');
    fs.mkdirSync(cacheRoot, { recursive: true });
    const cacheKey = hash([codeHashes[sourceFiles[0]], seed, [...used.keys()].sort()]), cacheFile = path.join(cacheRoot, `${cacheKey}.json`);
    let cached: [string, number[]][];
    if (fs.existsSync(cacheFile)) {
      const envelope = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      assert.equal(envelope.key, cacheKey); assert.equal(hash(envelope.rows), envelope.sha256); cached = envelope.rows;
    } else {
      cached = [...used].map(([key, row]) => [key, [...signature(row.input, seed)]]);
      fs.writeFileSync(cacheFile, JSON.stringify({ key: cacheKey, rows: cached, sha256: hash(cached) }));
    }
    assert.equal(cached.length, used.size);
    const signatures = new Map(cached.map(([key, values]) => { assert.ok(used.has(key) && values.length === 128 && values.every(v => Number.isInteger(v) && v >= 0 && v <= 0xffffffff)); return [key, Uint32Array.from(values)]; }));
    assert.equal(signatures.size, used.size);
    const signatureMsShared = performance.now() - signatureStart;
    for (const e of chosen.values()) {
      const map = strata.get(e.stratum)!;
      const candidates: Candidate[] = e.poolKeys.map((key: string) => { const row = map.get(key)!; return { key, inputKey: row.inputKey, task: taskType(row.input), signature: signatures.get(row.inputKey)!, lexical: lexical.get(row.inputKey)!, paths: [{ key, cells: [], knownDimensions: 0 }] }; });
      for (const k of seed === 42 ? (smoke ? [100, 20] : [100, 20, 500]) : [100]) {
        const methods: Record<string, any> = {};
        const measure = (method: string, select: () => string[]) => {
          const start = performance.now(), keys = select(), selectionMs = performance.now() - start;
          assert.equal(keys.length, Math.min(k, candidates.length)); assert.equal(new Set(keys).size, keys.length);
          const poolKeys = new Set(e.poolKeys); assert.ok(keys.every(key => poolKeys.has(key)));
          methods[method] = { selected: keys, metrics: metrics(keys.map(key => map.get(key)!)), selectionMs };
          return keys;
        };
        const frozen = e.trials.find((t: any) => t.seed === seed);
        if (k === 100) for (const method of ['B0', 'B1', 'B2']) measure(method, () => frozen.methods[method].selected.map((s: any) => s.key));
        else measure('B0', () => [...candidates].sort((a, b) => hash([LEGACY_POLICY.version, seed, 'random-pair', a.key]).localeCompare(hash([LEGACY_POLICY.version, seed, 'random-pair', b.key])) || a.key.localeCompare(b.key)).slice(0, k).map(c => c.key));
        const legacy = measure('B4', () => sample(candidates, k, { ...LEGACY_POLICY, seed }).selected.map(s => s.key));
        if (k === 100) assert.deepEqual(legacy, frozen.methods.B4.selected.map((s: any) => s.key), 'v4 replay must match frozen IDs exactly');
        const p = { ...POLICY, seed };
        const currentV5 = measure('C', () => sample(candidates, k, p).selected.map(s => s.key));
        const frozenScenario = frozenV5.scenarios.find((s: any) => s.stratum === e.stratum && s.population === e.population && s.k === k && s.seed === seed);
        assert.ok(frozenScenario); assert.deepEqual(currentV5, frozenScenario.methods.C.selected, 'v5 replay must match frozen IDs exactly');
        const runCandidate = (method: string, experiment: NeighborhoodExperiment) => {
          let result: ReturnType<typeof neighborhoodSample>;
          measure(method, () => { result = neighborhoodSample(candidates, k, { ...NEIGHBORHOOD_POLICY, seed }, experiment); return result.selected.map(s => s.key); });
          methods[method].optimization = result!.optimization;
        };
        const old = v6.scenarios.find((s: any) => s.stratum === e.stratum && s.population === e.population && s.k === k && s.seed === seed);
        assert.ok(old); methods.V6 = { ...old.methods.V6, timingSource: 'frozen prior run, not contemporaneous' };
        const old61 = v61.scenarios.find((s: any) => s.stratum === e.stratum && s.population === e.population && s.k === k && s.seed === seed);
        assert.ok(old61); methods.V61 = { ...old61.methods.V61, timingSource: 'frozen prior run, not contemporaneous' };
        const old62 = v62.scenarios.find((s: any) => s.stratum === e.stratum && s.population === e.population && s.k === k && s.seed === seed);
        assert.ok(old62); methods.V62 = { ...old62.methods.V62, timingSource: 'frozen prior run, not contemporaneous' };
        for (const [method, experiment] of Object.entries(variants)) runCandidate(method, experiment);
        if (seed === 42 && k === 100) for (const ratio of [1, 1.2]) runCandidate(`V63_${ratio}`, { budgetRatio: ratio });
        assert.deepEqual(methods.FAST.selected, methods.V62.selected, 'performance-only refinement must preserve v6.2 IDs');
        console.error(`${name} ${e.stratum}/${e.population} K=${k} seed=${seed} V63 vocabulary=${methods.V63.metrics.vocabulary} feasible=${methods.V63.optimization.feasible} neighborhood=${methods.V63.optimization.neighborhoodAccepted} ms=${methods.V63.selectionMs.toFixed(0)}`);
        report.scenarios.push({ stratum: e.stratum, population: e.population, n: candidates.length, k, seed, signatureMsShared, methods });
      }
    }
    fs.writeFileSync(path.join(outputRoot, `${name}.json`), JSON.stringify(report));
    console.error(`${name} seed=${seed} completed`);
  }
  report.finishedAt = new Date().toISOString();
  report.maxRssKiB = process.resourceUsage().maxRSS;
  fs.writeFileSync(path.join(outputRoot, `${name}.json`), JSON.stringify(report));
}
