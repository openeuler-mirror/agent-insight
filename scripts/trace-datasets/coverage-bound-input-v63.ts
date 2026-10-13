import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hash, normalizeText, lexicalFeatures, lengthBucket, taskType } from '../../src/lib/trace-datasets/sampling';
const [dataRoot, baselineRoot, outputRoot] = process.argv.slice(2);
if (!outputRoot) throw new Error('Usage: coverage-bound-input-v63.ts <data> <baseline> <output>');
fs.mkdirSync(outputRoot, { recursive: true });
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
for (const name of ['WildChat', 'Dolly', 'NoRobots', 'OASST2', 'ShareGPT4', 'UltraChat']) {
  const frozen = fs.readFileSync(path.join(baselineRoot, `${name}.json`)), baseline = JSON.parse(frozen.toString());
  const data = fs.readFileSync(path.join(dataRoot, baseline.source.file));
  assert.equal(sha(data), baseline.source.sha256);
  const source = baseline.experiments.filter((e: any) => e.population === 'all').sort((a: any, b: any) => Math.abs(a.requestedPool - 5000) - Math.abs(b.requestedPool - 5000))[0];
  const inputs = new Map<string, string>();
  for (const row of JSON.parse(data.toString())) if (row.input.trim() && row.reference_output.trim()) {
    const input = normalizeText(row.input); inputs.set(hash([input, normalizeText(row.reference_output)]), input);
  }
  const unique = new Map<string, string>();
  for (const key of source.poolKeys) { assert.ok(inputs.has(key)); const input = inputs.get(key)!; unique.set(hash([input]), input); }
  const terms = new Map<string, number>();
  const groups = [...unique].sort(([a], [b]) => a.localeCompare(b)).map(([inputKey, input]) => {
    const feature = lexicalFeatures(input);
    return { inputKey, cost: feature.tokenCount, bucket: lengthBucket(feature.tokenCount), task: taskType(input), terms: feature.terms.map(term => { if (!terms.has(term)) terms.set(term, terms.size); return terms.get(term)!; }) };
  });
  const k = Math.min(100, source.poolKeys.length), budget = Math.floor(1.1 * k * groups.reduce((sum, g) => sum + g.cost, 0) / groups.length + 1e-9);
  fs.writeFileSync(path.join(outputRoot, `${name}.json`), JSON.stringify({ name, k, budget, vocabulary: terms.size, groups, sourceSha256: sha(data), baselineSha256: sha(frozen), poolSha256: hash(source.poolKeys), exporterSha256: sha(fs.readFileSync('scripts/trace-datasets/coverage-bound-input-v63.ts')) }));
}
