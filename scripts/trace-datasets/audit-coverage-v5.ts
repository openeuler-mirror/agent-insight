import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const [dataRoot, baselineRoot, resultsRoot] = process.argv.slice(2);
if (!resultsRoot) throw new Error('Usage: audit-coverage-v5.ts <data> <baseline> <results>');
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const normalize = (s: string) => s.replace(/\r\n?/g, '\n').normalize('NFC');
type Pair = { tokens: string[]; quality: Record<string, number[]> };
const equalBudget: any[] = [];
let selectedItems = 0, qualityMeans = 0, scenarios = 0;
for (const name of ['WildChat', 'Dolly', 'NoRobots', 'OASST2', 'ShareGPT4', 'UltraChat', 'HelpSteer2', 'SummarizeFeedback']) {
  const report = JSON.parse(fs.readFileSync(path.join(resultsRoot, `${name}.json`), 'utf8'));
  assert.ok(report.finishedAt);
  const original = fs.readFileSync(path.join(baselineRoot, `${name}.json`));
  assert.equal(sha(original), report.baselineSha256);
  const baseline = JSON.parse(original.toString());
  const data = fs.readFileSync(path.join(dataRoot, baseline.source.file));
  assert.equal(sha(data), report.dataSha256);
  const strata = new Map<string, Map<string, Pair>>();
  for (const row of JSON.parse(data.toString())) {
    if (!row.input.trim() || !row.reference_output.trim()) continue;
    const stratum = name === 'SummarizeFeedback' ? `${row.domain}/${row.split}` : 'all';
    let pairs = strata.get(stratum); if (!pairs) { pairs = new Map(); strata.set(stratum, pairs); }
    const input = normalize(row.input), key = sha(JSON.stringify([input, normalize(row.reference_output)]));
    let pair = pairs.get(key);
    if (!pair) { pair = { tokens: input.toLowerCase().match(/\p{Script=Han}|[\p{L}\p{M}\p{N}]+/gu) || [], quality: {} }; pairs.set(key, pair); }
    for (const [axis, value] of Object.entries(row.quality || {})) if (typeof value === 'number' && Number.isFinite(value)) (pair.quality[axis] ||= []).push(value);
  }
  for (const scenario of report.scenarios) {
    scenarios++;
    const source = baseline.experiments.filter((e: any) => e.stratum === scenario.stratum && e.population === scenario.population).sort((a: any, b: any) => Math.abs(a.requestedPool - 5000) - Math.abs(b.requestedPool - 5000))[0];
    const pool = new Set<string>(source.poolKeys), pairs = strata.get(scenario.stratum)!;
    for (const [name, run] of Object.entries<any>(scenario.methods)) {
      const chosen: string[] = run.selected;
      assert.equal(chosen.length, Math.min(scenario.k, pool.size)); assert.equal(new Set(chosen).size, chosen.length);
      assert.ok(chosen.every(k => pool.has(k) && pairs.has(k))); selectedItems += chosen.length;
      const vocabulary = new Set<string>(), prefix = new Set<string>(), labels: Record<string, number[]> = {};
      let tokens = 0;
      for (const key of chosen) {
        const p = pairs.get(key)!; tokens += p.tokens.length;
        for (const term of p.tokens) vocabulary.add(term);
        for (const term of p.tokens.slice(0, 256)) prefix.add(term);
        for (const [axis, scores] of Object.entries(p.quality)) (labels[axis] ||= []).push(scores.reduce((a, b) => a + b, 0) / scores.length);
      }
      assert.equal(run.metrics.vocabulary, vocabulary.size); assert.equal(run.metrics.prefix256, prefix.size); assert.equal(run.metrics.tokens, tokens);
      assert.deepEqual(Object.keys(run.metrics.quality).sort(), Object.keys(labels).sort());
      for (const [axis, scores] of Object.entries(labels)) {
        assert.equal(run.metrics.quality[axis].labeled, scores.length);
        assert.ok(Math.abs(run.metrics.quality[axis].mean - scores.reduce((a, b) => a + b, 0) / scores.length) < 1e-10); qualityMeans++;
      }
      if (name === 'B4' && scenario.k === 100) assert.deepEqual(chosen, source.trials.find((t: any) => t.seed === scenario.seed).methods.B4.selected.map((s: any) => s.key));
    }
    const budget = Math.min(scenario.methods.B0.metrics.tokens, scenario.methods.C.metrics.tokens);
    const budgetVocabulary = (method: string) => {
      const ordered: string[] = [...scenario.methods[method].selected].sort((a, b) => sha(JSON.stringify(['budget-order', scenario.seed, a])).localeCompare(sha(JSON.stringify(['budget-order', scenario.seed, b]))) || a.localeCompare(b));
      const terms = new Set<string>(); let used = 0;
      for (const key of ordered) for (const token of pairs.get(key)!.tokens) { if (used++ >= budget) return terms.size; terms.add(token); }
      return terms.size;
    };
    equalBudget.push({ dataset: name, stratum: scenario.stratum, population: scenario.population, k: scenario.k, seed: scenario.seed, budget, B0: budgetVocabulary('B0'), C: budgetVocabulary('C') });
  }
}
fs.writeFileSync(path.join(resultsRoot, 'verification.json'), JSON.stringify({ passed: true, datasets: 8, scenarios, selectedItems, qualityMeans, checks: ['source/baseline hashes', 'all selected IDs in frozen pools and unique', 'all vocabulary/token/prefix metrics recomputed', 'all human score means recomputed', 'v4 K100 replay matches frozen IDs'], equalBudgetDefinition: 'Both methods observed at min(B0,C) total input tokens; stable hash ordering of selected inputs per seed, final input truncated only for this metric. Not a change to generated examples; not model-token cost.', equalBudget }, null, 2));
console.log(JSON.stringify({ passed: true, datasets: 8, scenarios, selectedItems, qualityMeans }));
