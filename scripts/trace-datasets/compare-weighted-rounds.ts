import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { hash, normalizeText, lexicalFeatures, lengthBucket, taskType, type Candidate } from '../../src/lib/trace-datasets/sampling';

const [dataRoot, baselineRoot, previousRoot, outputRoot, method, ...names] = process.argv.slice(2);
assert.ok(['V611', 'V612', 'V613'].includes(method));
const moduleNames = ['budgeted-reused', 'answer-weighted', 'budgeted-pairwise'];
const index = ['V611', 'V612', 'V613'].indexOf(method), moduleName = moduleNames[index];
const sampler = require(`../../src/lib/trace-datasets/sampling/${moduleName}`);
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const sourceFiles = ['src/lib/trace-datasets/sampling/index.ts', ...'budgeted-fast answer-consensus budgeted-agreement budgeted-block budgeted-accelerated answer-recall budgeted-tabu budgeted-indexed answer-shared'.split(' ').map(n => `src/lib/trace-datasets/sampling/${n}.ts`), ...moduleNames.slice(0, index + 1).map(n => `src/lib/trace-datasets/sampling/${n}.ts`), 'scripts/trace-datasets/compare-weighted-rounds.ts'];
const codeHashes = Object.fromEntries(sourceFiles.map(f => [f, sha(fs.readFileSync(f))]));
const plan = { version: 'weighted-three-rounds-1', method, seeds: [42, 100, 101, 102, 103], primaryK: 100, sensitivityK: [20, 500], budgetRatios: [1, 1.1, 1.2], codeHashes, labelsUsedForSelection: false, pool: 'Frozen v4 nearest 5000 per original stratum and population', limitation: 'Known development regression, not independent confirmation; external Microsoft numerical targets, not same-pool head-to-head.' };
fs.mkdirSync(outputRoot, { recursive: true });
const planFile = path.join(outputRoot, 'plan.json');
if (fs.existsSync(planFile)) assert.deepEqual(JSON.parse(fs.readFileSync(planFile, 'utf8')), plan);
else fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
type Pair = { input: string; answer: string; inputKey: string; tokens: string[]; labels: Record<string, number[]>; category?: string };
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
function metrics(rows: Pair[]) {
  const vocabulary = new Set<string>(), prefix = new Set<string>(), labels: Record<string, number[]> = {}, buckets = [0, 0, 0, 0];
  for (const row of rows) {
    row.tokens.forEach(t => vocabulary.add(t)); row.tokens.slice(0, 256).forEach(t => prefix.add(t)); buckets[lengthBucket(row.tokens.length)]++;
    for (const [axis, scores] of Object.entries(row.labels)) (labels[axis] ||= []).push(mean(scores));
  }
  return { count: rows.length, inputs: new Set(rows.map(r => r.inputKey)).size, vocabulary: vocabulary.size, prefix256: prefix.size, tokens: rows.reduce((s, r) => s + r.tokens.length, 0), meanInputChars: mean(rows.map(r => [...r.input].length)), buckets, nativeCategories: new Set(rows.map(r => r.category).filter(Boolean)).size, knownTasks: new Set(rows.map(r => taskType(r.input)).filter(t => t !== 'unknown')).size, quality: Object.fromEntries(Object.entries(labels).map(([axis, scores]) => [axis, { mean: mean(scores), labeled: scores.length }])) };
}
for (const name of names.length ? names : ['WildChat', 'Dolly', 'NoRobots', 'OASST2', 'ShareGPT4', 'UltraChat', 'HelpSteer2', 'SummarizeFeedback']) {
  const baselineBytes = fs.readFileSync(path.join(baselineRoot, `${name}.json`)), baseline = JSON.parse(baselineBytes.toString());
  const previousBytes = fs.readFileSync(path.join(previousRoot, `${name}.json`)), previous = JSON.parse(previousBytes.toString());
  assert.ok(previous.finishedAt);
  for (const [file, checksum] of Object.entries(previous.plan.codeHashes)) assert.equal(sha(fs.readFileSync(file)), checksum);
  const bytes = fs.readFileSync(path.join(dataRoot, baseline.source.file));
  assert.equal(sha(bytes), baseline.source.sha256); assert.equal(sha(bytes), previous.dataSha256);
  const strata = new Map<string, Map<string, Pair>>();
  for (const raw of JSON.parse(bytes.toString())) {
    if (!raw.input.trim() || !raw.reference_output.trim()) continue;
    const input = normalizeText(raw.input), answer = normalizeText(raw.reference_output), key = hash([input, answer]);
    const stratum = name === 'SummarizeFeedback' ? `${raw.domain}/${raw.split}` : 'all';
    if (!strata.has(stratum)) strata.set(stratum, new Map());
    const map = strata.get(stratum)!;
    if (!map.has(key)) map.set(key, { input, answer, inputKey: hash([input]), tokens: input.toLowerCase().match(/\p{Script=Han}|[\p{L}\p{M}\p{N}]+/gu) || [], labels: {}, category: raw.category });
    for (const [axis, value] of Object.entries(raw.quality || {})) if (typeof value === 'number' && Number.isFinite(value)) (map.get(key)!.labels[axis] ||= []).push(value);
  }
  const chosen = new Map<string, any>();
  for (const e of baseline.experiments) {
    const key = `${e.stratum}:${e.population}`, old = chosen.get(key);
    if (!old || Math.abs(e.requestedPool - 5000) < Math.abs(old.requestedPool - 5000)) chosen.set(key, e);
  }
  const used = new Map<string, Pair>();
  for (const e of chosen.values()) for (const key of e.poolKeys) { const row = strata.get(e.stratum)!.get(key)!; assert.ok(row); used.set(row.inputKey, row); }
  const lexical = new Map([...used].map(([key, row]) => [key, lexicalFeatures(row.input)]));
  const report: any = { name, plan, previousSha256: sha(previousBytes), baselineSha256: sha(baselineBytes), dataSha256: sha(bytes), startedAt: new Date().toISOString(), scenarios: [] };
  for (const seed of plan.seeds) {
    const cacheKey = hash([codeHashes[sourceFiles[0]], seed, [...used.keys()].sort()]);
    const envelope = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'agent-insight-research-signatures', `${cacheKey}.json`), 'utf8'));
    assert.equal(envelope.key, cacheKey); assert.equal(hash(envelope.rows), envelope.sha256);
    const signatures = new Map<string, Uint32Array>(envelope.rows.map(([key, values]: [string, number[]]) => { assert.ok(used.has(key) && values.length === 128); return [key, Uint32Array.from(values)]; }));
    assert.equal(signatures.size, used.size);
    for (const e of chosen.values()) {
      const map = strata.get(e.stratum)!;
      const candidates: Candidate[] = e.poolKeys.map((key: string) => { const row = map.get(key)!; return { key, inputKey: row.inputKey, task: taskType(row.input), lexical: lexical.get(row.inputKey)!, signature: signatures.get(row.inputKey)!, paths: [{ key, cells: [], knownDimensions: 0 }] }; });
      const answers = new Map<string, string>(e.poolKeys.map((key: string) => [key, map.get(key)!.answer]));
      for (const k of seed === 42 ? [100, 20, 500] : [100]) {
        const old = previous.scenarios.find((s: any) => s.stratum === e.stratum && s.population === e.population && s.k === k && s.seed === seed); assert.ok(old);
        const methods: any = Object.fromEntries(Object.entries<any>(old.methods).filter(([m]) => !['REPLAY', 'GAIN'].includes(m)).map(([m, v]) => [m, { ...v, timingSource: 'frozen prior round; use separate contemporaneous performance measurements' }]));
        for (const ratio of seed === 42 && k === 100 ? [1.1, 1, 1.2] : [1.1]) {
          const tag = `${method}${ratio === 1.1 ? '' : `_${ratio}`}`, start = performance.now();
          const result = index === 0 ? sampler.reusedSample(candidates, answers, k, { ...sampler.REUSED_POLICY, seed }, { budgetRatio: ratio }) : index === 1 ? sampler.weightedSample(candidates, answers, k, { ...sampler.WEIGHTED_POLICY, seed }, { budgetRatio: ratio }) : sampler.pairwiseSample(candidates, answers, k, { ...sampler.PAIRWISE_POLICY, seed }, { budgetRatio: ratio });
          const selectionMs = performance.now() - start, selected: string[] = result.selected.map((s: any) => s.key);
          assert.equal(selected.length, Math.min(k, candidates.length)); assert.equal(new Set(selected).size, selected.length); assert.ok(selected.every(key => answers.has(key)));
          methods[tag] = { selected, selections: result.selected, metrics: metrics(selected.map(key => map.get(key)!)), selectionMs, optimization: result.optimization, agreement: result.agreement, tabu: result.tabu, weighted: result.weighted, pairwise: result.pairwise };
          if (method === 'V611') {
            const prior = methods[`V610${ratio === 1.1 ? '' : `_${ratio}`}`];
            assert.deepEqual(selected, prior.selected, 'v6.11 must preserve every ordered v6.10 ID');
            assert.deepEqual(result.selected, prior.selections, 'v6.11 must preserve paths and reasons');
            assert.deepEqual(result.agreement, prior.agreement); assert.deepEqual(result.tabu, prior.tabu);
            assert.deepEqual({ ...result.optimization, requestedPolicy: prior.optimization.requestedPolicy, effectivePolicy: prior.optimization.effectivePolicy }, prior.optimization, 'v6.11 must preserve diagnostics');
          }
        }
        console.error(`${name} ${e.stratum}/${e.population} K=${k} seed=${seed} ${method} vocabulary=${methods[method].metrics.vocabulary} feasible=${methods[method].optimization.feasible} ms=${methods[method].selectionMs.toFixed(0)}`);
        report.scenarios.push({ stratum: e.stratum, population: e.population, n: candidates.length, k, seed, methods });
      }
    }
    fs.writeFileSync(path.join(outputRoot, `${name}.json`), JSON.stringify(report));
  }
  report.finishedAt = new Date().toISOString(); report.maxRssKiB = process.resourceUsage().maxRSS;
  fs.writeFileSync(path.join(outputRoot, `${name}.json`), JSON.stringify(report));
}
