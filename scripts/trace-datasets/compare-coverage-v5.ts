import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { COVERAGE_POLICY as POLICY, LEGACY_POLICY, hash, normalizeText, signature, lexicalFeatures, lengthBucket, sample, taskType, type Candidate } from '../../src/lib/trace-datasets/sampling';

const [dataRoot, baselineRoot, outputRoot, ...names] = process.argv.slice(2);
if (!outputRoot) throw new Error('Usage: compare-coverage-v5.ts <data> <frozen-v4-results> <output> [dataset ...]');
fs.mkdirSync(outputRoot, { recursive: true });
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const seeds = [42, 100, 101, 102, 103];
const plan = { version: 'coverage-v5-comparison-2', policy: POLICY, baseline: LEGACY_POLICY, seeds, primaryK: 100, sensitivityK: [20, 500], sensitivitySeed: 42, pool: 'frozen v4 pool nearest 5000 for each original stratum and population', lengthControl: 'input-group proportions with largest remainder; bucket token budget quota * pool mean; preserve cheapest completion; task/behavior floors can override', methods: ['B0 frozen random pairs', 'B1 frozen random input groups', 'B2 frozen text-only', 'B4 replayed v4', 'A length-only v5', 'B coverage-only v5', 'C candidate v5 (default remains v4)'], limitations: 'Known regression data, not independent holdout. No observed tool paths. Quality labels used only after selection. Revised length control after exploratory run; no independent generalization claim.' };
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
  const report: any = { name, plan, baselineSha256: sha(baselineData), dataSha256: sha(data), codeSha256: sha(fs.readFileSync('src/lib/trace-datasets/sampling/index.ts')), runnerSha256: sha(fs.readFileSync('scripts/trace-datasets/compare-coverage-v5.ts')), startedAt: new Date().toISOString(), lexicalMsShared: lexicalMs, scenarios: [] };
  for (const seed of seeds) {
    const signatureStart = performance.now();
    const signatures = new Map([...used].map(([key, row]) => [key, signature(row.input, seed)]));
    const signatureMsShared = performance.now() - signatureStart;
    for (const e of chosen.values()) {
      const map = strata.get(e.stratum)!;
      const candidates: Candidate[] = e.poolKeys.map((key: string) => { const row = map.get(key)!; return { key, inputKey: row.inputKey, task: taskType(row.input), signature: signatures.get(row.inputKey)!, lexical: lexical.get(row.inputKey)!, paths: [{ key, cells: [], knownDimensions: 0 }] }; });
      for (const k of seed === 42 ? [100, 20, 500] : [100]) {
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
        measure('A', () => sample(candidates, k, p, { coverage: false }).selected.map(s => s.key));
        measure('B', () => sample(candidates, k, p, { stratify: false }).selected.map(s => s.key));
        measure('C', () => sample(candidates, k, p).selected.map(s => s.key));
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
