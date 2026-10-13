import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const [dataRoot, resultRoot, outputFile] = process.argv.slice(2);
if (!outputFile) throw new Error('Usage: explain-calibrated-quality.ts <data> <results> <output>');
const sha = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');
const normalize = (v: string) => v.replace(/\r\n?/g, '\n').normalize('NFC');
const mean = (values: number[]) => values.reduce((n, v) => n + v, 0) / values.length;
const rows: any[] = [], sources: any[] = [];
for (const name of ['OASST2', 'HelpSteer2', 'SummarizeFeedback']) {
  const bytes = fs.readFileSync(path.join(dataRoot, `${name}.json`)), results = fs.readFileSync(path.join(resultRoot, `${name}.json`)), report = JSON.parse(results.toString());
  assert.ok(report.finishedAt); assert.equal(sha(bytes), report.dataSha256);
  sources.push({ dataset: name, dataSha256: sha(bytes), resultsSha256: sha(results) });
  const pairs = new Map<string, { inputKey: string; labels: Record<string, number[]> }>();
  for (const raw of JSON.parse(bytes.toString())) {
    if (!raw.input.trim() || !raw.reference_output.trim()) continue;
    const input = normalize(raw.input), answer = normalize(raw.reference_output), stratum = name === 'SummarizeFeedback' ? `${raw.domain}/${raw.split}` : 'all';
    const key = `${stratum}:${sha(JSON.stringify([input, answer]))}`;
    if (!pairs.has(key)) pairs.set(key, { inputKey: sha(JSON.stringify([input])), labels: {} });
    for (const [axis, value] of Object.entries(raw.quality || {})) if (typeof value === 'number' && Number.isFinite(value)) (pairs.get(key)!.labels[axis] ||= []).push(value);
  }
  const strata = [...new Set<string>(report.scenarios.map((s: any) => s.stratum))];
  for (const stratum of strata) for (const [from, to] of [['V626','V627'],['V627','V628'],['V626','V629'],['V629','V630'],['V630','V631']]) {
    const population = name === 'OASST2' ? 'quality-annotated' : 'all', axis = name === 'OASST2' ? 'quality' : name === 'HelpSteer2' ? 'helpfulness' : 'overall';
    const trials = report.scenarios.filter((s: any) => s.k === 100 && s.stratum === stratum && s.population === population);
    assert.equal(trials.length, 5);
    const record = { dataset: name, stratum, population, axis, from, to, improved: 0, worsened: 0, equal: 0, notComparable: 0, inputChanges: 0, answerChanges: 0, observedMeanDelta: 0, cases: [] as any[] };
    for (const trial of trials) {
      const before = trial.methods[from], after = trial.methods[to];
      record.observedMeanDelta += (after.metrics.quality[axis].mean - before.metrics.quality[axis].mean) / trials.length;
      assert.equal(before.selected.length, after.selected.length);
      before.selected.forEach((oldKey: string, index: number) => {
        const newKey = after.selected[index]; if (oldKey === newKey) return;
        const a = pairs.get(`${stratum}:${oldKey}`)!, b = pairs.get(`${stratum}:${newKey}`)!; assert.ok(a && b);
        if (a.inputKey === b.inputKey) record.answerChanges++; else record.inputChanges++;
        if (!a.labels[axis]?.length || !b.labels[axis]?.length) { record.notComparable++; return; }
        const oldScore = mean(a.labels[axis]), newScore = mean(b.labels[axis]);
        if (newScore > oldScore) record.improved++; else if (newScore < oldScore) record.worsened++; else record.equal++;
        record.cases.push({ seed: trial.seed, index, oldKey, newKey, oldScore, newScore, sameInput: a.inputKey === b.inputKey });
      });
    }
    if (to === 'V627' || to === 'V629') assert.equal(record.inputChanges, 0);
    rows.push(record);
  }
}
fs.writeFileSync(outputFile, JSON.stringify({ postSelectionOnly: true, definitions: 'Counts are changed selected positions across five seeds, not distinct corpus records. Missing scores are not counted as ties. No labels enter selection.', sources, scriptSha256: sha(fs.readFileSync('scripts/trace-datasets/explain-calibrated-quality.ts')), rows }, null, 2));
console.log(JSON.stringify(rows.map(({ cases, ...r }) => r)));
