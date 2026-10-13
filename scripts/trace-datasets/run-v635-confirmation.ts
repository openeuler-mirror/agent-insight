import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { hash, lexicalFeatures, taskType, signature, sample, LEGACY_POLICY, COVERAGE_POLICY, type Candidate } from '../../src/lib/trace-datasets/sampling';
import { evidenceSample, EVIDENCE_POLICIES } from '../../src/lib/trace-datasets/sampling/budgeted-evidence';
import { baseHashes, signatureFromBase } from './confirmation-signature';

const [root, name] = process.argv.slice(2);
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const protocolBytes = fs.readFileSync(path.join(root, 'protocol.json')), protocol = JSON.parse(protocolBytes.toString());
for (const [file, value] of Object.entries(protocol.codeHashes)) assert.equal(sha(fs.readFileSync(file)), value);
const manifestBytes = fs.readFileSync(path.join(root, 'pool-manifest.json')), manifest = JSON.parse(manifestBytes.toString());
const bytes = fs.readFileSync(path.join(root, `${name}-text.json`));
assert.equal(sha(bytes), manifest.sources[name].textSha256);
type Row = { key: string; input: string; answer: string; component: string };
const rows: Row[] = JSON.parse(bytes.toString());
assert.ok(rows.every(r => Object.keys(r).sort().join(',') === 'answer,component,input,key'));
for (const r of rows) assert.equal(r.key, hash([r.input, r.answer]));
const lexical = new Map(rows.map(r => [hash([r.input]), lexicalFeatures(r.input)]));
const bases = new Map(rows.map(r => [hash([r.input]), baseHashes(r.input)]));
const allComponents = [...new Set(rows.map(r => r.component))].sort((a, b) => sha('confirmation-panel-20261013:' + a).localeCompare(sha('confirmation-panel-20261013:' + b)));
const componentPanel = new Map(allComponents.map(g => [g, parseInt(sha('confirmation-panel-20261013:' + g).slice(0,8),16) % protocol.panelCount]));
const pools = [{ id: 'full', rows }, ...Array.from({ length: protocol.panelCount }, (_, i) => ({ id: `panel-${i}`, rows: rows.filter(r => componentPanel.get(r.component) === i) }))];
const ownFiles = ['scripts/trace-datasets/run-v635-confirmation.ts', 'scripts/trace-datasets/confirmation-signature.ts', 'scripts/trace-datasets/prepare-v635-confirmation.py'];
const report: any = { name, protocolSha256: sha(protocolBytes), poolManifestSha256: sha(manifestBytes), textSha256: sha(bytes), startedAt: new Date().toISOString(), codeHashes: Object.fromEntries(ownFiles.map(f => [f, sha(fs.readFileSync(f))])), labelsRead: false, skippedPanels: [], scenarios: [], signatureChecks: 0 };
for (const seed of protocol.seeds as number[]) {
  const signatures = new Map([...bases].map(([key, base]) => [key, signatureFromBase(base, seed)]));
  for (const r of rows.slice(0, 3)) { assert.deepEqual(signatures.get(hash([r.input])), signature(r.input, seed)); report.signatureChecks++; }
  for (const pool of pools) {
    if (pool.id !== 'full' && !protocol.panelSeeds.includes(seed)) continue;
    if (pool.rows.length < protocol.minPanelPairs) { if (seed === 200) report.skippedPanels.push({ id: pool.id, n: pool.rows.length, reason: 'fewer than 100 candidates' }); continue; }
    const candidates: Candidate[] = pool.rows.map(r => ({ key: r.key, inputKey: hash([r.input]), task: taskType(r.input), lexical: lexical.get(hash([r.input]))!, signature: signatures.get(hash([r.input]))!, paths: [{ key: r.key, cells: [], knownDimensions: 0 }] }));
    const answers = new Map(pool.rows.map(r => [r.key, r.answer]));
    const ks = pool.id === 'full' && seed === 200 ? [100, 20, 500] : [100];
    for (const k of ks) {
      const scenario: any = { pool: pool.id, seed, k, n: pool.rows.length, groupCount: new Set(pool.rows.map(r => r.component)).size, poolKeys: pool.rows.map(r => r.key), methods: {} };
      for (const method of protocol.methods as string[]) {
        const start = performance.now();
        const result = method === 'B0' ? { selected: [...candidates].sort((a,b) => hash([LEGACY_POLICY.version,seed,'random-pair',a.key]).localeCompare(hash([LEGACY_POLICY.version,seed,'random-pair',b.key])) || a.key.localeCompare(b.key)).slice(0,k).map(c => ({ key: c.key })), optimization: undefined } : method === 'V4' || method === 'V5' ? sample(candidates, k, { ...(method === 'V4' ? LEGACY_POLICY : COVERAGE_POLICY), seed }) : evidenceSample(candidates, answers, k, { ...EVIDENCE_POLICIES[method], seed });
        const selectionMs = performance.now() - start;
        const selected = result.selected.map(r => r.key);
        assert.equal(selected.length, Math.min(k,candidates.length)); assert.equal(new Set(selected).size,selected.length); assert.ok(selected.every(key => answers.has(key)));
        scenario.methods[method] = { selected, selectionMs, ...('optimization' in result ? { optimization: result.optimization } : {}) };
      }
      report.scenarios.push(scenario);
    }
  }
  fs.writeFileSync(path.join(root, `${name}-selections.json`), JSON.stringify(report));
  console.error(`${name} seed ${seed} scenarios ${report.scenarios.length}`);
}
report.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(root, `${name}-selections.json`), JSON.stringify(report));
