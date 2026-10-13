import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { hash, normalizeText, LEGACY_POLICY as POLICY, sample, signature, taskType, textDistance, type Candidate } from '../../src/lib/trace-datasets/sampling';
const root = process.argv[2];
if (!root) throw new Error('Usage: node --import tsx scripts/trace-datasets/public-experiment.ts <download-directory>');
type Row = { input: string; reference_output: string; language?: string; category?: string; quality?: Record<string, number>; rowId: number; group?: string; laterTurnsSkipped?: number };
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
function ngrams(text: string, width: number) { const chars = [...text]; return new Set(chars.slice(width - 1).map((_, i) => chars.slice(i, i + width).join(''))); }
const outputs = [];
for (const source of manifest) {
  const raw: Row[] = JSON.parse(fs.readFileSync(path.join(root, source.file), 'utf8'));
  const pairs = new Map<string, Row>(); let empty = 0;
  for (const row of raw) { row.input = normalizeText(row.input); row.reference_output = normalizeText(row.reference_output); if (!row.input.trim() || !row.reference_output.trim()) { empty++; continue; } pairs.set(hash([row.input, row.reference_output]), row); }
  const inputRows = new Map<string, Row>(); for (const r of pairs.values()) inputRows.set(hash([r.input]), r);
  const partition = (key: string) => parseInt(hash(['split-20261011', key]).slice(0, 8), 16) % 100 < 70 ? 'development' : 'holdout';
  const auditKeys = [...inputRows.keys()], auditSignatures = auditKeys.map(k => signature(inputRows.get(k)!.input));
  const quarantine = new Set<string>(); let exactAudits = 0;
  for (let i = 0; i < auditKeys.length; i++) for (let j = i + 1; j < auditKeys.length; j++) {
    if (partition(auditKeys[i]) === partition(auditKeys[j]) || textDistance(auditSignatures[i], auditSignatures[j]) > .30) continue;
    exactAudits++;
    const a = ngrams(inputRows.get(auditKeys[i])!.input, 5), b = ngrams(inputRows.get(auditKeys[j])!.input, 5);
    let overlap = 0; for (const g of a) if (b.has(g)) overlap++;
    if (overlap / (a.size + b.size - overlap) >= .85) { quarantine.add(auditKeys[i]); quarantine.add(auditKeys[j]); }
  }
  const experiments = [];
  for (const split of ['development', 'holdout']) {
    const entries = [...pairs].filter(([, r]) => !quarantine.has(hash([r.input])) && partition(hash([r.input])) === split);
    const rows = new Map(entries), sigCache = new Map<string, Uint32Array>();
    const featureStarted = performance.now();
    // Keep one frozen signature family for the paired seed study; selection seeds vary only ranking.
    const pool: Candidate[] = entries.map(([key, r]) => { const inputKey = hash([r.input]); let sig = sigCache.get(inputKey); if (!sig) { sig = signature(r.input, 42); sigCache.set(inputKey, sig); } return { key, inputKey, task: taskType(r.input), signature: sig, paths: [{ key, cells: [], knownDimensions: 0 }] }; });
    const featureMs = performance.now() - featureStarted;
    const allLexical = new Set<string>(); const lexical = new Map<string, Set<string>>();
    for (const [key, row] of entries) { const grams = ngrams(row.input, 3); lexical.set(key, grams); for (const g of grams) allLexical.add(g); }
    const metrics = (selected: string[]) => {
      const selectedRows = selected.map(k => rows.get(k)!); const cells = new Set<string>();
      for (const key of selected) for (const g of lexical.get(key)!) cells.add(g);
      const languages: Record<string, number> = {}, categories = new Set<string>(), tasks = new Set<string>(); const quality: Record<string, number[]> = {};
      for (const r of selectedRows) { languages[r.language || 'unknown'] = (languages[r.language || 'unknown'] || 0) + 1; if (r.category) categories.add(r.category); const task = taskType(r.input); if (task !== 'unknown') tasks.add(task); for (const [key, value] of Object.entries(r.quality || {})) (quality[key] ||= []).push(value); }
      return { count: selected.length, independentInputs: new Set(selectedRows.map(r => hash([r.input]))).size, lexical3gramCoverage: allLexical.size ? cells.size / allLexical.size : null, taskTypes: tasks.size, nativeCategories: categories.size, meanInputChars: selectedRows.reduce((n, r) => n + [...r.input].length, 0) / selected.length, meanAnswerChars: selectedRows.reduce((n, r) => n + [...r.reference_output].length, 0) / selected.length, languages, quality: Object.fromEntries(Object.entries(quality).map(([k, v]) => [k, { mean: v.reduce((a, b) => a + b, 0) / v.length, labeled: v.length }])) };
    };
    const seeds = split === 'development' ? [0,1,2,3,4] : Array.from({ length: 20 }, (_, i) => 100 + i);
    for (const seed of seeds) for (const k of [20,50,100,200,500]) {
      const rank = (phase: string, key: string) => hash([POLICY.version, seed, phase, key]);
      const order = (phase: string, a: string, b: string) => rank(phase, a).localeCompare(rank(phase, b));
      const started = performance.now();
      const b0 = [...pool].sort((a, b) => order('random-pair', a.key, b.key)).slice(0, k).map(c => c.key);
      const groups = new Map<string, string[]>();
      for (const c of pool) { const group = groups.get(c.inputKey) || []; group.push(c.key); groups.set(c.inputKey, group); }
      for (const group of groups.values()) group.sort((a, b) => order('answer', a, b));
      const groupOrder = [...groups.keys()].sort((a, b) => order('random-input', a, b)), b1: string[] = [];
      for (let round = 0; b1.length < Math.min(k, pool.length); round++) for (const key of groupOrder) { const next = groups.get(key)![round]; if (next && b1.length < k) b1.push(next); }
      const p = { version: POLICY.version, seed, rho: 0 };
      const b2 = sample(pool.map(c => ({ ...c, task: 'unknown' })), k, p).selected.map(c => c.key);
      const b3 = sample(pool, k, p).selected.map(c => c.key);
      const b4 = sample(pool, k, { ...p, rho: .2 }).selected.map(c => c.key);
      if (JSON.stringify(b3) !== JSON.stringify(b4)) throw new Error('No-behavior B4 must equal B3');
      experiments.push({ split, seed, k, n: pool.length, u: groups.size, featureMs, selectionMsAllMethods: performance.now() - started, methods: Object.fromEntries([b0,b1,b2,b3,b4].map((selected, i) => [`B${i}`, metrics(selected)])), selectedIds: Object.fromEntries([b0,b1,b2,b3,b4].map((selected, i) => [`B${i}`, selected.map(k => rows.get(k)!.rowId)])) });
    }
  }
  outputs.push({ ...source, empty, uniquePairs: pairs.size, inputs: inputRows.size, quarantinedInputGroups: quarantine.size, exactNearDuplicateAudits: exactAudits, laterTurnsSkipped: raw.reduce((n, r) => n + (r.laterTurnsSkipped || 0), 0), experiments });
  console.error(`${source.repo} complete`);
}
console.log(JSON.stringify({ policy: POLICY, signatureSeed: 42, selectionSeeds: 'dev 0–4; holdout 100–119', limitation: 'First-1000 convenience subsets; fixed signature family for paired ranking study; near-duplicate candidate recall is approximate. No behavior observations, no correctness truth for WildChat/Dolly. This is a pilot, not a population or Foundry-service benchmark.', peakRss: process.resourceUsage().maxRSS * 1024, sources: outputs }, null, 2));
