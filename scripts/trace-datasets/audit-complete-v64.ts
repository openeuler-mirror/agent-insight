import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const [dataRoot, baselineRoot, v5Root, v6Root, v61Root, v62Root, v63Root, resultsRoot, ...names] = process.argv.slice(2);
if (!resultsRoot) throw new Error('Usage: audit-complete-v64.ts <data> <v4> <v5> <v6> <v61> <v62> <v63> <results>');
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const normalize = (s: string) => s.replace(/\r\n?/g, '\n').normalize('NFC');
type Pair = { input: string; inputKey: string; tokens: string[]; quality: Record<string, number[]> };
const datasets = names.length ? names : ['WildChat', 'Dolly', 'NoRobots', 'OASST2', 'ShareGPT4', 'UltraChat', 'HelpSteer2', 'SummarizeFeedback'];
const equalBudget: any[] = [], constraints: any[] = [], noise: any[] = [];
const bucket = (n: number) => n <= 32 ? 0 : n <= 128 ? 1 : n <= 512 ? 2 : 3;
const task = (input: string) => {
 const rules = [/\b(code|debug|implement|refactor|function|program|script|sql)\b|代码|编程|函数|修复.*bug/i, /\b(analy[sz]e|extract|classify|convert|calculate|csv|json)\b|分析|提取|分类|计算|转换/i, /\b(send|schedule|deploy|install|delete|create.*ticket)\b|发送|部署|安装|删除|创建.*工单/i, /\b(write|draft|compose|translate|summari[sz]e)\b|写作|撰写|翻译|总结|摘要/i, /\b(what|who|when|where|why|how|find|search|explain)\b|查询|搜索|什么|如何|解释|为什么/i];
 const index = rules.findIndex(rule => rule.test(input)); return index < 0 ? 5 : index;
};
const deviation = (selected: Pair[], pool: Pair[], classifier: (p: Pair) => number, count: number) => {
 const a = Array(count).fill(0), b = Array(count).fill(0);
 selected.forEach(p => a[classifier(p)]++); pool.forEach(p => b[classifier(p)]++);
 return a.reduce((sum, n, i) => sum + Math.abs(n / selected.length - b[i] / pool.length), 0) / 2;
};
let selectedItems = 0, qualityMeans = 0, scenarios = 0;
for (const name of datasets) {
  const report = JSON.parse(fs.readFileSync(path.join(resultsRoot, `${name}.json`), 'utf8'));
  assert.ok(report.finishedAt);
  for (const [file, expected] of Object.entries(report.plan.codeHashes)) assert.equal(sha(fs.readFileSync(file)), expected);
  const v6Data = fs.readFileSync(path.join(v6Root, `${name}.json`));
  assert.equal(sha(v6Data), report.v6Sha256); const v6 = JSON.parse(v6Data.toString());
  const v61Data = fs.readFileSync(path.join(v61Root, `${name}.json`));
  assert.equal(sha(v61Data), report.v61Sha256); const v61 = JSON.parse(v61Data.toString());
  const v62Data = fs.readFileSync(path.join(v62Root, `${name}.json`));
  assert.equal(sha(v62Data), report.v62Sha256); const v62 = JSON.parse(v62Data.toString());
  const v63Data = fs.readFileSync(path.join(v63Root, `${name}.json`));
  assert.equal(sha(v63Data), report.v63Sha256); const v63 = JSON.parse(v63Data.toString());
  const v5Data = fs.readFileSync(path.join(v5Root, `${name}.json`));
  assert.equal(sha(v5Data), report.v5Sha256); const v5 = JSON.parse(v5Data.toString());
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
    if (!pair) { pair = { input, inputKey: sha(JSON.stringify([input])), tokens: input.toLowerCase().match(/\p{Script=Han}|[\p{L}\p{M}\p{N}]+/gu) || [], quality: {} }; pairs.set(key, pair); }
    for (const [axis, value] of Object.entries(row.quality || {})) if (typeof value === 'number' && Number.isFinite(value)) (pair.quality[axis] ||= []).push(value);
  }
  for (const scenario of report.scenarios) {
    scenarios++;
    const source = baseline.experiments.filter((e: any) => e.stratum === scenario.stratum && e.population === scenario.population).sort((a: any, b: any) => Math.abs(a.requestedPool - 5000) - Math.abs(b.requestedPool - 5000))[0];
    const pool = new Set<string>(source.poolKeys), pairs = strata.get(scenario.stratum)!;
    for (const [method, run] of Object.entries<any>(scenario.methods)) {
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
      if (method === 'C') assert.deepEqual(chosen, v5.scenarios.find((s: any) => s.stratum === scenario.stratum && s.population === scenario.population && s.k === scenario.k && s.seed === scenario.seed).methods.C.selected);
      if (method === 'V6') assert.deepEqual(chosen, v6.scenarios.find((s: any) => s.stratum === scenario.stratum && s.population === scenario.population && s.k === scenario.k && s.seed === scenario.seed).methods.V6.selected);
      if (method === 'V61') assert.deepEqual(chosen, v61.scenarios.find((s: any) => s.stratum === scenario.stratum && s.population === scenario.population && s.k === scenario.k && s.seed === scenario.seed).methods.V61.selected);
      if (method === 'V62') assert.deepEqual(chosen, v62.scenarios.find((s: any) => s.stratum === scenario.stratum && s.population === scenario.population && s.k === scenario.k && s.seed === scenario.seed).methods.V62.selected);
      if (method === 'V63') assert.deepEqual(chosen, v63.scenarios.find((s: any) => s.stratum === scenario.stratum && s.population === scenario.population && s.k === scenario.k && s.seed === scenario.seed).methods.V63.selected);
      if (method === 'REPLAY') assert.deepEqual(chosen, scenario.methods.V63.selected);
      if (run.optimization) {
        const o = run.optimization, unique = (ids: string[]) => [...new Map(ids.map(id => { const p = pairs.get(id)!; return [p.inputKey, p]; })).values()];
        const sourceGroups = unique(source.poolKeys), selectedGroups = unique(chosen);
        const base = chosen.length * sourceGroups.reduce((sum, p) => sum + p.tokens.length, 0) / sourceGroups.length;
        const ratio = method === 'V64_1' ? 1 : method === 'V64_1.2' ? 1.2 : 1.1;
        const cap = Math.floor(base * ratio + 1e-9), lengthTV = deviation(selectedGroups, sourceGroups, p => bucket(p.tokens.length), 4), taskTV = deviation(selectedGroups, sourceGroups, p => task(p.input), 6);
        assert.ok(Math.abs(o.baseTokens - base) < 1e-7); assert.equal(o.tokenBudget, cap); assert.equal(o.tokens, tokens); assert.equal(o.vocabulary, vocabulary.size);
        assert.ok(Math.abs(o.lengthTV - lengthTV) < 1e-10); assert.ok(Math.abs(o.taskTV - taskTV) < 1e-10);
        assert.equal(o.lengthLimit, Math.max(.1, 2 / selectedGroups.length)); assert.equal(o.taskLimit, Math.max(.2, 2 / selectedGroups.length));
        if (o.feasible) { assert.ok(tokens <= cap); assert.equal(o.effectivePolicy, method === 'V6' ? 'trace-coverage-v6' : method === 'V61' ? 'trace-coverage-v6.1' : method === 'V62' ? 'trace-coverage-v6.2' : method === 'V63' ? 'trace-coverage-v6.3' : 'trace-coverage-v6.4'); if (o.distributionEnabled) { assert.ok(lengthTV <= o.lengthLimit + 1e-9); assert.ok(taskTV <= o.taskLimit + 1e-9); } }
        else { assert.equal(o.effectivePolicy, 'trace-coverage-v4'); assert.deepEqual(chosen, scenario.methods.B4.selected); }
        if ('coverageUpperBound' in o) {
          const termFrequency = new Map<string, number>();
          for (const p of sourceGroups) for (const term of new Set(p.tokens)) termFrequency.set(term, (termFrequency.get(term) || 0) + 1);
          const largest = (values: number[]) => values.sort((a, b) => b - a).slice(0, chosen.length).reduce((a, b) => a + b, 0);
          const shared = [...termFrequency.values()].filter(n => n > 1).length;
          const bound = Math.min(termFrequency.size, largest(sourceGroups.map(p => new Set(p.tokens).size)), shared + largest(sourceGroups.map(p => [...new Set(p.tokens)].filter(t => termFrequency.get(t) === 1).length)));
          assert.equal(o.coverageUpperBound, bound); assert.equal(o.coverageGap, bound - vocabulary.size); assert.ok(o.coverageGap >= 0);
        }
        constraints.push({ dataset: name, stratum: scenario.stratum, population: scenario.population, k: scenario.k, seed: scenario.seed, method, feasible: o.feasible, tokens, cap, lengthTV, taskTV });
      }
      const suspect = [...vocabulary].filter(t => t.length >= 24 && /[a-z]/.test(t) && /[0-9]/.test(t)).length;
      noise.push({ dataset: name, stratum: scenario.stratum, population: scenario.population, k: scenario.k, seed: scenario.seed, method, longAlphanumericTerms: suspect, vocabularyWithoutLongAlphanumeric: vocabulary.size - suspect });
      if (method === 'B4'  && scenario.k === 100) assert.deepEqual(chosen, source.trials.find((t: any) => t.seed === scenario.seed).methods.B4.selected.map((s: any) => s.key));
    }
    if (scenario.methods.V63.optimization.feasible) for (const method of ['GAIN', 'V64']) {
      assert.ok(scenario.methods[method].optimization.feasible);
      assert.ok(scenario.methods[method].metrics.vocabulary >= scenario.methods.V63.metrics.vocabulary);
      if (scenario.methods[method].metrics.vocabulary === scenario.methods.V63.metrics.vocabulary) assert.ok(scenario.methods[method].metrics.tokens <= scenario.methods.V63.metrics.tokens);
    }
    const budget = Math.min(...['B0', 'B4', 'C', 'V6', 'V61', 'V62', 'V63', 'V64'].map(m => scenario.methods[m].metrics.tokens));
    const budgetVocabulary = (method: string) => {
      const ordered: string[] = [...scenario.methods[method].selected].sort((a, b) => sha(JSON.stringify(['budget-order', scenario.seed, a])).localeCompare(sha(JSON.stringify(['budget-order', scenario.seed, b]))) || a.localeCompare(b));
      const terms = new Set<string>(); let used = 0;
      for (const key of ordered) for (const token of pairs.get(key)!.tokens) { if (used++ >= budget) return terms.size; terms.add(token); }
      return terms.size;
    };
    equalBudget.push({ dataset: name, stratum: scenario.stratum, population: scenario.population, k: scenario.k, seed: scenario.seed, budget, ...Object.fromEntries(['B0', 'B4', 'C', 'V6', 'V61', 'V62', 'V63', 'GAIN', 'V64'].map(m => [m, budgetVocabulary(m)])) });
  }
}
fs.writeFileSync(path.join(resultsRoot, 'verification.json'), JSON.stringify({ passed: true, datasets: datasets.length, scenarios, selectedItems, qualityMeans, checks: ['source/baseline hashes', 'all selected IDs in frozen pools and unique', 'all vocabulary/token/prefix metrics recomputed', 'all human score means recomputed', 'v4 K100 and v5/v6 all replay match frozen IDs', 'REPLAY preserves every v6.3 selected ID', 'GAIN/V64 raw coverage never regresses vs feasible v6.3; equal coverage never costs more', 'budget/TV/cost/coverage and upper bounds independently recomputed', 'fallback equals frozen v4 selection', 'sampler and runner source fingerprints'], equalBudgetDefinition: 'Eight methods observed at min(B0,B4,C,V6,V61,V62,V63,V64) total input tokens; stable hash ordering of selected inputs per seed, final input truncated only for this metric. Not a change to generated examples; not model-token cost.', equalBudget, constraints, noise, auditorSha256: sha(fs.readFileSync('scripts/trace-datasets/audit-complete-v64.ts')) }, null, 2));
console.log(JSON.stringify({ passed: true, datasets: datasets.length, scenarios, selectedItems, qualityMeans }));
