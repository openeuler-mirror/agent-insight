import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const [dataRoot, baselineRoot, previousRoot, resultsRoot, ...names] = process.argv.slice(2);
if (!resultsRoot) throw new Error('Usage: audit-information-rounds.ts <data> <v4> <previous> <results>');
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
  const priorBytes = fs.readFileSync(path.join(previousRoot, `${name}.json`));
  assert.equal(sha(priorBytes), report.previousSha256);
  const prior = JSON.parse(priorBytes.toString());
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
      const old = prior.scenarios.find((s: any) => s.stratum === scenario.stratum && s.population === scenario.population && s.k === scenario.k && s.seed === scenario.seed);
      assert.ok(old);
      if (old.methods[method]) { assert.deepEqual(chosen, old.methods[method].selected); assert.deepEqual(run.metrics, old.methods[method].metrics); }
      if (run.optimization) {
        const o = run.optimization, unique = (ids: string[]) => [...new Map(ids.map(id => { const p = pairs.get(id)!; return [p.inputKey, p]; })).values()];
        const sourceGroups = unique(source.poolKeys), selectedGroups = unique(chosen);
        const base = chosen.length * sourceGroups.reduce((sum, p) => sum + p.tokens.length, 0) / sourceGroups.length;
        const ratio = method.endsWith('_1') ? 1 : method.endsWith('_1.2') ? 1.2 : 1.1;
        const cap = Math.floor(base * ratio + 1e-9), lengthTV = deviation(selectedGroups, sourceGroups, p => bucket(p.tokens.length), 4), taskTV = deviation(selectedGroups, sourceGroups, p => task(p.input), 6);
        assert.ok(Math.abs(o.baseTokens - base) < 1e-7); assert.equal(o.tokenBudget, cap); assert.equal(o.tokens, tokens); assert.equal(o.vocabulary, vocabulary.size);
        assert.ok(Math.abs(o.lengthTV - lengthTV) < 1e-10); assert.ok(Math.abs(o.taskTV - taskTV) < 1e-10);
        assert.equal(o.lengthLimit, Math.max(.1, 2 / selectedGroups.length)); assert.equal(o.taskLimit, Math.max(.2, 2 / selectedGroups.length));
        if (o.feasible) { assert.ok(tokens <= cap); assert.equal(o.effectivePolicy, method === 'V6' ? 'trace-coverage-v6' : `trace-coverage-v6.${method.split('_')[0].slice(2)}`); if (o.distributionEnabled) { assert.ok(lengthTV <= o.lengthLimit + 1e-9); assert.ok(taskTV <= o.taskLimit + 1e-9); } }
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
    for (const method of ['V65', 'V66', 'V67'].filter(m => scenario.methods[m])) {
      const current = scenario.methods[method], base = scenario.methods.V64;
      if (base.optimization.feasible) { assert.ok(current.optimization.feasible); assert.ok(current.metrics.vocabulary >= base.metrics.vocabulary); }
      if (method === 'V65') { assert.deepEqual(current.selected, base.selected); assert.deepEqual(current.metrics, base.metrics); }
      if (method === 'V66') { assert.equal(current.metrics.tokens, base.metrics.tokens); assert.equal(current.metrics.vocabulary, base.metrics.vocabulary); assert.deepEqual(current.selected.map((k: string) => pairs.get(k)!.inputKey), base.selected.map((k: string) => pairs.get(k)!.inputKey)); }
      for (const pick of current.selections || []) { assert.equal(pick.path.key, pick.key); assert.deepEqual(pick.path.cells, []); }
    }
    for (const method of ['V68', 'V69', 'V610'].filter(m => scenario.methods[m])) {
      const current = scenario.methods[method], base = scenario.methods[method === 'V68' ? 'V67' : method === 'V69' ? 'V68' : 'V69'];
      if (base.optimization.feasible) { assert.ok(current.optimization.feasible); assert.ok(current.metrics.vocabulary >= base.metrics.vocabulary); }
      if (method === 'V68') { assert.deepEqual(current.selected, base.selected); assert.deepEqual(current.selections, base.selections); assert.deepEqual(current.metrics, base.metrics); }
      if (method === 'V69') { assert.equal(current.metrics.tokens, base.metrics.tokens); assert.equal(current.metrics.vocabulary, base.metrics.vocabulary); assert.deepEqual(current.selected.map((k: string) => pairs.get(k)!.inputKey), base.selected.map((k: string) => pairs.get(k)!.inputKey)); }
      if (method === 'V610' && current.metrics.vocabulary === base.metrics.vocabulary && base.optimization.feasible) assert.ok(current.metrics.tokens <= base.metrics.tokens);
      for (const pick of current.selections || []) { assert.equal(pick.path.key, pick.key); assert.deepEqual(pick.path.cells, []); }
    }
    for (const method of ['V611', 'V612', 'V613'].filter(m => scenario.methods[m])) {
      for (const suffix of ['', '_1', '_1.2']) {
        const current = scenario.methods[method + suffix], base = scenario.methods[(method === 'V611' ? 'V610' : method === 'V612' ? 'V611' : 'V612') + suffix];
        if (!current) continue;
        assert.ok(base);
        if (method === 'V611') { assert.deepEqual(current.selected, base.selected); assert.deepEqual(current.selections, base.selections); assert.deepEqual(current.metrics, base.metrics); assert.deepEqual(current.agreement, base.agreement); assert.deepEqual(current.tabu, base.tabu); assert.deepEqual({ ...current.optimization, requestedPolicy: base.optimization.requestedPolicy, effectivePolicy: base.optimization.effectivePolicy }, base.optimization); }
        if (method === 'V612') { assert.equal(current.metrics.tokens, base.metrics.tokens); assert.equal(current.metrics.vocabulary, base.metrics.vocabulary); assert.deepEqual(current.selected.map((k: string) => pairs.get(k)!.inputKey), base.selected.map((k: string) => pairs.get(k)!.inputKey)); }
        if (method === 'V613' && base.optimization.feasible) { assert.ok(current.metrics.vocabulary >= base.metrics.vocabulary); if (current.metrics.vocabulary === base.metrics.vocabulary) assert.ok(current.metrics.tokens <= base.metrics.tokens); }
      }
    }
    for (const method of ['V614', 'V615', 'V616'].filter(m => scenario.methods[m])) for (const suffix of ['', '_1', '_1.2']) {
      const current = scenario.methods[method + suffix]; if (!current) continue;
      for (const pick of current.selections) { assert.equal(pick.path.key, pick.key); assert.deepEqual(pick.path.cells, []); }
      const base = scenario.methods[(method === 'V616' ? 'V615' : 'V614') + suffix];
      if (method === 'V615' && base.optimization.feasible) { assert.ok(current.optimization.feasible); assert.ok(current.metrics.vocabulary >= base.metrics.vocabulary); if (current.metrics.vocabulary === base.metrics.vocabulary) assert.ok(current.metrics.tokens <= base.metrics.tokens); }
      if (method === 'V616') { assert.equal(current.metrics.tokens, base.metrics.tokens); assert.equal(current.metrics.vocabulary, base.metrics.vocabulary); assert.deepEqual(current.selected.map((k: string) => pairs.get(k)!.inputKey), base.selected.map((k: string) => pairs.get(k)!.inputKey)); }
    }
    for (const method of ['V617', 'V618', 'V619'].filter(m => scenario.methods[m])) for (const suffix of ['', '_1', '_1.2']) {
      const current = scenario.methods[method + suffix]; if (!current) continue;
      const base = scenario.methods[(method === 'V617' ? 'V616' : method === 'V618' ? 'V617' : 'V618') + suffix];
      for (const pick of current.selections) { assert.equal(pick.path.key, pick.key); assert.deepEqual(pick.path.cells, []); }
      if (method === 'V617') {
        assert.deepEqual(current.selected, base.selected); assert.deepEqual(current.selections, base.selections); assert.deepEqual(current.metrics, base.metrics);
        for (const field of ['weighted', 'crossing', 'highRecall']) assert.deepEqual(current[field], base[field]);
        assert.deepEqual({ ...current.optimization, requestedPolicy: base.optimization.requestedPolicy, effectivePolicy: base.optimization.effectivePolicy }, base.optimization);
      }
      if (method === 'V618') { assert.equal(current.metrics.tokens, base.metrics.tokens); assert.equal(current.metrics.vocabulary, base.metrics.vocabulary); assert.deepEqual(current.selected.map((k: string) => pairs.get(k)!.inputKey), base.selected.map((k: string) => pairs.get(k)!.inputKey)); }
      if (method === 'V619' && base.optimization.feasible) { assert.ok(current.optimization.feasible); assert.ok(current.metrics.vocabulary >= base.metrics.vocabulary); assert.equal(current.metrics.inputs, base.metrics.inputs); assert.ok(current.proxy.finalScore >= current.proxy.initialScore - 1e-10); }
    }
    for (const method of ['V620', 'V621', 'V622'].filter(m => scenario.methods[m])) for (const suffix of ['', '_1', '_1.2']) {
      const current = scenario.methods[method + suffix]; if (!current) continue;
      const base = scenario.methods[(method === 'V620' ? 'V619' : method === 'V621' ? 'V620' : 'V621') + suffix];
      for (const pick of current.selections) { assert.equal(pick.path.key, pick.key); assert.deepEqual(pick.path.cells, []); }
      if (method === 'V620') {
        assert.deepEqual(current.selected, base.selected); assert.deepEqual(current.selections, base.selections); assert.deepEqual(current.metrics, base.metrics);
        for (const field of ['weighted', 'crossing', 'highRecall', 'grounded', 'proxy']) assert.deepEqual(current[field], base[field]);
        assert.deepEqual({ ...current.optimization, requestedPolicy: base.optimization.requestedPolicy, effectivePolicy: base.optimization.effectivePolicy }, base.optimization);
      }
      if (method === 'V621') { assert.equal(current.metrics.tokens, base.metrics.tokens); assert.equal(current.metrics.vocabulary, base.metrics.vocabulary); assert.deepEqual(current.selected.map((k: string) => pairs.get(k)!.inputKey), base.selected.map((k: string) => pairs.get(k)!.inputKey)); }
      if (method === 'V622' && base.optimization.feasible) { assert.ok(current.optimization.feasible); assert.ok(current.metrics.vocabulary >= base.metrics.vocabulary); assert.equal(current.metrics.inputs, base.metrics.inputs); assert.ok(current.informationSearch.finalScore >= current.informationSearch.initialScore - 1e-10); }
    }
    const measured = ['B0', 'B4', 'C', 'V6', 'V61', 'V62', 'V63', 'V64', 'V65', 'V66', 'V67', 'V68', 'V69', 'V610', 'V611', 'V612', 'V613', 'V614', 'V615', 'V616', 'V617', 'V618', 'V619', 'V620', 'V621', 'V622'].filter(m => scenario.methods[m]);
    const fixedBudget = Math.min(...['B0', 'B4', 'C', 'V6', 'V61', 'V62', 'V63', 'V64'].map(m => scenario.methods[m].metrics.tokens));
    const budget = Math.min(...measured.map(m => scenario.methods[m].metrics.tokens));
    const budgetVocabulary = (method: string, cap = budget) => {
      const ordered: string[] = [...scenario.methods[method].selected].sort((a, b) => sha(JSON.stringify(['budget-order', scenario.seed, a])).localeCompare(sha(JSON.stringify(['budget-order', scenario.seed, b]))) || a.localeCompare(b));
      const terms = new Set<string>(); let used = 0;
      for (const key of ordered) for (const token of pairs.get(key)!.tokens) { if (used++ >= cap) return terms.size; terms.add(token); }
      return terms.size;
    };
    equalBudget.push({ dataset: name, stratum: scenario.stratum, population: scenario.population, k: scenario.k, seed: scenario.seed, budget, ...Object.fromEntries(measured.map(m => [m, budgetVocabulary(m)])), fixedBudget, fixed: Object.fromEntries(measured.map(m => [m, budgetVocabulary(m, fixedBudget)])) });
  }
}
fs.writeFileSync(path.join(resultsRoot, 'verification.json'), JSON.stringify({ passed: true, datasets: datasets.length, scenarios, selectedItems, qualityMeans, checks: ['source/baseline hashes', 'all selected IDs in frozen pools and unique', 'all vocabulary/token/prefix metrics recomputed', 'all human score means recomputed', 'v4 K100 and v5/v6 all replay match frozen IDs', 'V65 reproduces V64 IDs and metrics', 'V66 preserves input sequence, tokens and vocabulary', 'V67 preserves raw coverage floor', 'V68 preserves all V67 IDs, paths, reasons and metrics', 'V69 preserves ordered inputs, tokens and raw vocabulary', 'V610 publishes no raw coverage regression; equal coverage costs no more', 'budget/TV/cost/coverage and upper bounds independently recomputed', 'fallback equals frozen v4 selection', 'V611 exactly replays V610 IDs/paths/reasons/diagnostics at all budgets', 'V612 preserves ordered inputs, cost and vocabulary at all budgets', 'V613 preserves coverage floor and equal-coverage cost bound at all budgets', 'V614 real paths checked', 'V615 publishes feasible coverage non-regression against V614 at every budget', 'V616 preserves V615 ordered inputs, coverage and cost at every budget', 'V617 exact replay of V616 selections and diagnostics at every budget', 'V618 preserves ordered inputs, cost and coverage', 'V619 feasible coverage floor, unique-input count and reported proxy score monotonicity', 'V620 exact replay of V619 across all budgets', 'V621 preserves ordered inputs and costs', 'V622 feasible coverage floor, unique-input count and reported proxy monotonicity', 'sampler and runner source fingerprints'], equalBudgetDefinition: 'All available main methods observed at their common minimum tokens; fixed uses original min(B0,B4,C,V6,V61,V62,V63,V64); stable hash ordering of selected QA IDs per seed, final input truncated only for this metric. Not a change to generated examples; not model-token cost.', equalBudget, constraints, noise, auditorSha256: sha(fs.readFileSync('scripts/trace-datasets/audit-information-rounds.ts')) }, null, 2));
console.log(JSON.stringify({ passed: true, datasets: datasets.length, scenarios, selectedItems, qualityMeans }));
