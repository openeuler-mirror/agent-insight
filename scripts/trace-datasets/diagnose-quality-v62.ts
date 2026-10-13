import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { hash, normalizeText, lexicalFeatures } from '../../src/lib/trace-datasets/sampling';

const [dataRoot, baselineRoot, v61Root, output] = process.argv.slice(2);
const average = (xs: (number | null | undefined)[] = []) => {
  const values = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
};
const reports = [];
for (const name of ['OASST2', 'HelpSteer2', 'SummarizeFeedback']) {
  const rows = JSON.parse(fs.readFileSync(path.join(dataRoot, `${name}.json`), 'utf8'));
  const v4 = JSON.parse(fs.readFileSync(path.join(baselineRoot, `${name}.json`), 'utf8'));
  const v61 = JSON.parse(fs.readFileSync(path.join(v61Root, `${name}.json`), 'utf8'));
  const pairs = new Map<string, { inputKey: string; length: number; labels: Record<string, number[]> }>();
  for (const row of rows) {
    const input = normalizeText(row.input), key = hash([input, normalizeText(row.reference_output)]);
    let p = pairs.get(key);
    if (!p) { p = { inputKey: hash([input]), length: lexicalFeatures(input).tokenCount, labels: {} }; pairs.set(key, p); }
    for (const [axis, score] of Object.entries(row.quality || {})) if (typeof score === 'number' && Number.isFinite(score)) (p.labels[axis] ||= []).push(score);
  }
  const selected = new Map<string, any>();
  for (const e of v4.experiments) {
    const key = `${e.stratum}:${e.population}`, old = selected.get(key);
    if (!old || Math.abs(e.requestedPool - 5000) < Math.abs(old.requestedPool - 5000)) selected.set(key, e);
  }
  for (const e of selected.values()) {
    if (name === 'OASST2' && e.population !== 'quality-annotated') continue;
    const pool = e.poolKeys.map((key: string) => ({ key, ...pairs.get(key)! }));
    const axes = Object.keys(pool[0].labels);
    const inputMeans = new Map<string, Record<string, number[]>>();
    for (const p of pool) {
      const group = inputMeans.get(p.inputKey) || {};
      for (const axis of axes) (group[axis] ||= []).push(average(p.labels[axis])!);
      inputMeans.set(p.inputKey, group);
    }
    const order = [...pool].sort((a, b) => a.length - b.length || a.key.localeCompare(b.key));
    const quartiles = [0, 1, 2, 3].map(q => {
      const subset = order.slice(Math.floor(q * order.length / 4), Math.floor((q + 1) * order.length / 4));
      return { quartile: q + 1, n: subset.length, minLength: subset[0].length, maxLength: subset.at(-1)!.length, quality: Object.fromEntries(axes.map(axis => [axis, average(subset.map(p => average(p.labels[axis])!))])) };
    });
    const trials = v61.scenarios.filter((s: any) => s.stratum === e.stratum && s.population === e.population && s.k === 100).map((s: any) => {
      const chosen = s.methods.V61.selected.map((key: string) => pairs.get(key)!);
      const quality = Object.fromEntries(axes.map(axis => {
        const actual = average(chosen.map((p: any) => average(p.labels[axis])!))!;
        const inputMean = average(chosen.map((p: any) => average(inputMeans.get(p.inputKey)![axis])!))!;
        assert.ok(Math.abs(actual - s.methods.V61.metrics.quality[axis].mean) < 1e-9);
        return [axis, { actual, inputMean, answerResidual: actual - inputMean }];
      }));
      return { seed: s.seed, meanLength: average(chosen.map((p: any) => p.length)), quality };
    });
    reports.push({ dataset: name, stratum: e.stratum, population: e.population, count: pool.length, inputs: inputMeans.size, poolMeanLength: average(pool.map((p: any) => p.length)), poolQuality: Object.fromEntries(axes.map(axis => [axis, average(pool.map((p: any) => average(p.labels[axis])!))])), quartiles, trials });
  }
}
fs.writeFileSync(output, JSON.stringify({ caveat: 'Post-selection diagnostic only; labels and these relationships are never passed to the sampler. Correlation is not causation or a quality predictor.', reports }, null, 2));
