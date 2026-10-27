import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { hash, normalizeText, LEGACY_POLICY as POLICY, sample, signature, taskType, type Candidate } from '../../../src/lib/trace-datasets/sampling';

type Raw = { input: string; reference_output: string; group: string; rowId: string; language?: string; category?: string; quality?: Record<string, number>; domain?: string; split?: string };
type Pair = Raw & { key: string; inputKey: string; groupKey: string; refs: string[]; labels: Record<string, number[]>; tokens: string[]; task: string };
const [dataRoot, outRoot, ...requested] = process.argv.slice(2);
if (!dataRoot || !outRoot) throw new Error('Usage: compare-eight-datasets.ts <data-directory> <output-directory> [dataset ...]');
fs.mkdirSync(outRoot, { recursive: true });
const seeds = [42, 100, 101, 102, 103];
const plan = {
  version: 'eight-public-datasets-v1', policy: POLICY, selectionSeeds: seeds, signatureSeeds: seeds,
  poolSeed: 20261011, requestedPools: [1000, 5000, 10000], k: 100,
  mapping: 'first user/assistant pair; OASST root direct answers; summary domains/original splits separate',
  grouping: 'connected components of source group and identical normalized input; intact groups within candidate pools',
  methods: ['B0 random unique QA', 'B1 random input groups', 'B2 text farthest-first approximation', 'B3 task-floor + text', 'B4 production policy without observed tool behavior'],
  tokenizer: 'NFC lowercase; Unicode Han codepoints individually, other letters/marks/numbers in words; punctuation excluded',
  quality: 'mean available human ratings per exact QA; not passed to sampler; OASST annotated subpool also reported',
  intervals: '2000 paired bootstrap resamples of five algorithm seeds; conditional on this fixed pool, not population confidence',
  prohibitedInference: 'not exact Microsoft source/code reproduction; no LLM judge, fine-tuning or tool behavior benefit experiment',
};
const planPath = path.join(outRoot, 'evaluation-plan.json');
if (fs.existsSync(planPath)) assert.deepEqual(JSON.parse(fs.readFileSync(planPath, 'utf8')), plan, 'refuse mixing experiment plans');
else fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
const sourceFiles = ['src/lib/trace-datasets/sampling/index.ts', 'test/helpers/trace-datasets/compare-eight-datasets.ts', 'test/helpers/trace-datasets/fetch-eight-datasets.py'];
fs.writeFileSync(path.join(outRoot, 'implementation.json'), JSON.stringify({ files: sourceFiles.map(file => ({ file, sha256: hash(fs.readFileSync(file, 'utf8')) })), hashEncoding: 'SHA256(JSON.stringify(file UTF8 text))', hardware: { cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, totalMemory: os.totalmem(), node: process.version } }, null, 2));
const manifest: any[] = fs.readdirSync(dataRoot, { withFileTypes: true }).filter(e => e.isDirectory() && fs.existsSync(path.join(dataRoot, e.name, 'manifest.json'))).map(e => JSON.parse(fs.readFileSync(path.join(dataRoot, e.name, 'manifest.json'), 'utf8')));
const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
function tokens(input: string) { return input.toLowerCase().match(/\p{Script=Han}|[\p{L}\p{M}\p{N}]+/gu) || []; }
function prepare(raw: Raw[]) {
  const pairs = new Map<string, Pair>(), parents = new Map<string, string>();
  const root = (x: string): string => { let p = parents.get(x); if (!p) { parents.set(x, x); return x; } if (p !== x) { p = root(p); parents.set(x, p); } return p; };
  const union = (a: string, b: string) => { a = root(a); b = root(b); if (a !== b) parents.set(a < b ? b : a, a < b ? a : b); };
  let empty = 0;
  for (const row of raw) {
    if (typeof row.input !== 'string' || typeof row.reference_output !== 'string' || !row.input.trim() || !row.reference_output.trim()) { empty++; continue; }
    const input = normalizeText(row.input), reference_output = normalizeText(row.reference_output);
    const key = hash([input, reference_output]), inputKey = hash([input]), sourceGroup = 'g:' + row.group;
    union(sourceGroup, 'i:' + inputKey);
    let pair = pairs.get(key);
    if (!pair) { pair = { ...row, input, reference_output, key, inputKey, groupKey: sourceGroup, refs: [], labels: {}, tokens: tokens(input), task: taskType(input) }; pairs.set(key, pair); }
    pair.refs.push(row.rowId);
    for (const [key, value] of Object.entries(row.quality || {})) if (Number.isFinite(value)) (pair.labels[key] ||= []).push(value);
  }
  for (const pair of pairs.values()) pair.groupKey = root(pair.groupKey);
  return { rows: [...pairs.values()].sort((a, b) => a.key.localeCompare(b.key)), excludedEmpty: empty, duplicateRows: raw.length - empty - pairs.size };
}
function candidatePool(rows: Pair[], size: number) {
  const groups = new Map<string, Pair[]>();
  for (const row of rows) { const group = groups.get(row.groupKey) || []; group.push(row); groups.set(row.groupKey, group); }
  const order = [...groups.keys()].sort((a, b) => hash([plan.poolSeed, a]).localeCompare(hash([plan.poolSeed, b])) || a.localeCompare(b));
  const result: Pair[] = [];
  for (const group of order) { const members = groups.get(group)!; if (result.length + members.length <= size) result.push(...members); }
  return result;
}
function metrics(selected: Pair[]) {
  const vocabulary = new Set<string>(), prefix = new Set<string>(), langs: Record<string, number> = {}, q: Record<string, number[]> = {};
  let totalTokens = 0;
  for (const row of selected) {
    totalTokens += row.tokens.length;
    row.tokens.forEach(t => vocabulary.add(t)); row.tokens.slice(0, 256).forEach(t => prefix.add(t));
    langs[row.language || 'unknown'] = (langs[row.language || 'unknown'] || 0) + 1;
    for (const [key, values] of Object.entries(row.labels)) (q[key] ||= []).push(mean(values)!);
  }
  return { count: selected.length, independentInputs: new Set(selected.map(r => r.inputKey)).size, sourceGroups: new Set(selected.map(r => r.groupKey)).size, vocabulary: vocabulary.size, totalTokens, unigramDiversity: totalTokens ? vocabulary.size / totalTokens : 0, vocabularyPrefix256: prefix.size, knownTasks: new Set(selected.map(r => r.task).filter(t => t !== 'unknown')).size, nativeCategories: new Set(selected.map(r => r.category).filter(Boolean)).size, meanInputChars: mean(selected.map(r => [...r.input].length)), meanAnswerChars: mean(selected.map(r => [...r.reference_output].length)), languages: langs, quality: Object.fromEntries(Object.entries(q).map(([k, v]) => [k, { mean: mean(v), labeled: v.length }])) };
}
function aggregate(trials: any[]) {
  const keys = ['count', 'independentInputs', 'sourceGroups', 'vocabulary', 'totalTokens', 'unigramDiversity', 'vocabularyPrefix256', 'knownTasks', 'nativeCategories', 'meanInputChars', 'meanAnswerChars'];
  const methods: Record<string, any> = {};
  for (const method of ['B0', 'B1', 'B2', 'B3', 'B4']) {
    const values = trials.map(t => t.methods[method].metrics);
    methods[method] = Object.fromEntries(keys.map(k => { const a = values.map(v => v[k]); return [k, { mean: mean(a), min: Math.min(...a), max: Math.max(...a) }]; }));
    const qualityKeys = [...new Set(values.flatMap(v => Object.keys(v.quality)))];
    methods[method].quality = Object.fromEntries(qualityKeys.map(k => [k, { mean: mean(values.filter(v => v.quality[k]).map(v => v.quality[k].mean)), labeledMean: mean(values.map(v => v.quality[k]?.labeled || 0)) }]));
    methods[method].selectionMs = mean(trials.map(t => t.methods[method].selectionMs));
  }
  const comparisons: Record<string, any> = {};
  for (const [a, b] of [['B2', 'B0'], ['B4', 'B0'], ['B4', 'B2']]) {
    const fields = [...keys, ...new Set(trials.flatMap(t => Object.keys(t.methods[a].metrics.quality)).map(k => 'quality.' + k))];
    comparisons[`${a}-${b}`] = Object.fromEntries(fields.map(field => {
      const get = (t: any, m: string) => field.startsWith('quality.') ? t.methods[m].metrics.quality[field.slice(8)]?.mean : t.methods[m].metrics[field];
      const paired = trials.filter(t => typeof get(t, a) === 'number' && typeof get(t, b) === 'number');
      const differences = paired.map(t => get(t, a) - get(t, b));
      let state = 20261011;
      const rand = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
      const boot = Array.from({ length: 2000 }, () => mean(differences.map(() => differences[Math.floor(rand() * differences.length)]))).filter((v): v is number => v !== null).sort((x, y) => x - y);
      const baseline = mean(paired.map(t => get(t, b))), difference = mean(differences);
      return [field, { pairedSeeds: paired.length, difference, relativePercent: baseline && difference !== null ? 100 * difference / baseline : null, seedBootstrap95: boot.length ? [boot[49], boot[1949]] : null }];
    }));
  }
  return { methods, comparisons };
}
async function runDataset(source: any) {
  const data = fs.readFileSync(path.join(dataRoot, source.file));
  const { createHash } = await import('node:crypto');
  assert.equal(createHash('sha256').update(data).digest('hex'), source.sha256, 'data SHA mismatch');
  const raw: Raw[] = JSON.parse(data.toString('utf8'));
  const strata = new Map<string, Raw[]>();
  for (const row of raw) { const key = source.name === 'SummarizeFeedback' ? `${row.domain}/${row.split}` : 'all'; const list = strata.get(key) || []; list.push(row); strata.set(key, list); }
  const report: any = { source, planVersion: plan.version, experiments: [], startedAt: new Date().toISOString() };
  for (const [stratum, records] of strata) {
    const prepared = prepare(records);
    const populations: [string, Pair[]][] = [['all', prepared.rows]];
    if (source.name === 'OASST2') populations.push(['quality-annotated', prepared.rows.filter(r => r.labels.quality?.length)]);
    for (const [population, all] of populations) {
      if (!all.length) throw new Error(`${source.name}/${stratum}/${population}: empty normalized pool`);
      const sizes = [...new Set(plan.requestedPools.map(n => Math.min(n, all.length)))];
      const pools = sizes.map(size => ({ requested: size, rows: candidatePool(all, size) })).filter(p => p.rows.length);
      const used = new Map<string, Pair>(); for (const pool of pools) for (const row of pool.rows) used.set(row.key, row);
      const trialsBySize = new Map<number, any[]>(pools.map(p => [p.requested, []]));
      for (const seed of seeds) {
        const signatures = new Map<string, Uint32Array>(); const featureStart = performance.now();
        for (const row of used.values()) if (!signatures.has(row.inputKey)) signatures.set(row.inputKey, signature(row.input, seed));
        const featureMs = performance.now() - featureStart;
        for (const pool of pools) {
          const map = new Map(pool.rows.map(r => [r.key, r]));
          const candidates: Candidate[] = pool.rows.map(row => ({ key: row.key, inputKey: row.inputKey, task: row.task, signature: signatures.get(row.inputKey)!, paths: [{ key: row.key, cells: [], knownDimensions: 0 }] }));
          const policy = { version: POLICY.version, seed, rho: POLICY.rho };
          const methods: Record<string, any> = {};
          const measure = (name: string, select: () => string[]) => {
            const start = performance.now(); const keys = select(); const selectionMs = performance.now() - start;
            assert.equal(keys.length, Math.min(plan.k, candidates.length)); assert.equal(new Set(keys).size, keys.length);
            assert.ok(keys.every(k => map.has(k)));
            const chosen = keys.map(k => map.get(k)!);
            methods[name] = { metrics: metrics(chosen), selectionMs, selected: keys.map(k => ({ key: k, sourceGroup: map.get(k)!.groupKey, rowIds: map.get(k)!.refs })) };
            return keys;
          };
          const order = (phase: string, a: string, b: string) => hash([POLICY.version, seed, phase, a]).localeCompare(hash([POLICY.version, seed, phase, b])) || a.localeCompare(b);
          measure('B0', () => [...candidates].sort((a, b) => order('random-pair', a.key, b.key)).slice(0, plan.k).map(c => c.key));
          measure('B1', () => {
            const groups = new Map<string, string[]>(); for (const c of candidates) { const group = groups.get(c.inputKey) || []; group.push(c.key); groups.set(c.inputKey, group); }
            for (const group of groups.values()) group.sort((a, b) => order('answer', a, b));
            const orderGroups = [...groups.keys()].sort((a, b) => order('random-input', a, b)), selected: string[] = [];
            for (let round = 0; selected.length < Math.min(plan.k, candidates.length); round++) for (const key of orderGroups) { const next = groups.get(key)![round]; if (next && selected.length < plan.k) selected.push(next); }
            return selected;
          });
          const b2 = measure('B2', () => sample(candidates.map(c => ({ ...c, task: 'unknown' })), plan.k, { ...policy, rho: 0 }).selected.map(c => c.key));
          const b3 = measure('B3', () => sample(candidates, plan.k, { ...policy, rho: 0 }).selected.map(c => c.key));
          const b4 = measure('B4', () => sample(candidates, plan.k, policy).selected.map(c => c.key));
          assert.deepEqual(b3, b4, 'without observed behavior B4 must equal B3');
          trialsBySize.get(pool.requested)!.push({ seed, featureMsSharedAcrossPools: featureMs, signatureInputs: signatures.size, methods, b2B4Overlap: b2.filter(k => new Set(b4).has(k)).length, maxRssKiB: process.resourceUsage().maxRSS });
          console.error(`${source.name}/${stratum}/${population} N=${pool.rows.length} seed=${seed} complete`);
        }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      for (const pool of pools) {
        const trials = trialsBySize.get(pool.requested)!;
        const item = { stratum, population, availablePairs: all.length, rawRows: records.length, duplicateRows: prepared.duplicateRows, excludedEmpty: prepared.excludedEmpty, requestedPool: pool.requested, actualPairs: pool.rows.length, actualInputs: new Set(pool.rows.map(r => r.inputKey)).size, actualSourceGroups: new Set(pool.rows.map(r => r.groupKey)).size, poolKeys: pool.rows.map(r => r.key), poolMetrics: metrics(pool.rows), trials, ...aggregate(trials) };
        report.experiments.push(item);
      }
      fs.writeFileSync(path.join(outRoot, `${source.name}.json`), JSON.stringify(report, null, 2));
    }
  }
  report.finishedAt = new Date().toISOString(); report.maxRssKiB = process.resourceUsage().maxRSS;
  fs.writeFileSync(path.join(outRoot, `${source.name}.json`), JSON.stringify(report, null, 2));
}
async function main() {
  const chosen = manifest.filter(s => !requested.length || requested.includes(s.name));
  assert.ok(chosen.length, 'No completed dataset manifests');
  for (const source of chosen) await runDataset(source);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
