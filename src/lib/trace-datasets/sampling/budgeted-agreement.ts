import { lengthBucket, type Candidate, type Policy, type Selection } from './index';
import { FAST_POLICY, fastSampleSteps, type FastExperiment } from './budgeted-fast';
import { agreementFeaturesSteps, consensusReplaceSteps } from './answer-consensus';

export const AGREEMENT_POLICY = Object.freeze({ ...FAST_POLICY, version: 'trace-coverage-v6.7' });
const tv = (counts: number[], size: number, pool: number[]) => counts.reduce((sum, n, i) => sum + Math.abs(n / size - pool[i]), 0) / 2;

export function* agreementSampleSteps(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = AGREEMENT_POLICY, experiment: FastExperiment = {}) {
  if (policy.version !== AGREEMENT_POLICY.version) throw new Error('INVALID_CONFIG');
  const baseline = yield* fastSampleSteps(candidates, limit, { ...policy, version: FAST_POLICY.version }, experiment);
  if (!baseline.optimization.feasible) return { ...baseline, optimization: { ...baseline.optimization, requestedPolicy: policy.version }, agreement: { replacements: 0, comparisons: 0, inputSwaps: 0, fallbackUnchanged: true } };
  const features = yield* agreementFeaturesSteps(candidates, answers);
  const changed = yield* consensusReplaceSteps(candidates, baseline.selected, features);
  const selected = [...changed.selected], byKey = new Map(candidates.map(c => [c.key, c]));
  const taskNames = [...new Set(candidates.map(c => c.task))].sort(); if (!taskNames.includes('unknown')) taskNames.push('unknown');
  const vocabulary = new Map<string, number>();
  const groups = [...features.groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => {
    const tasks = [...new Set(rows.map(r => r.task).filter(t => t !== 'unknown'))];
    const termIds = rows[0].lexical!.terms.map(t => { if (!vocabulary.has(t)) vocabulary.set(t, vocabulary.size); return vocabulary.get(t)!; });
    return { key, rows: [...rows].sort((a, b) => features.scores.get(b.key)! - features.scores.get(a.key)! || a.key.localeCompare(b.key)), terms: Uint32Array.from(termIds), cost: rows[0].lexical!.tokenCount, bucket: lengthBucket(rows[0].lexical!.tokenCount), task: taskNames.indexOf(tasks.length === 1 ? tasks[0] : 'unknown'), score: features.groupScores.get(key)! };
  });
  const byInput = new Map(groups.map((g, i) => [g.key, i]));
  const groupOf = (s: Selection) => byInput.get(byKey.get(s.key)!.inputKey)!;
  const requiredTasks = new Set(selected.map(s => groups[groupOf(s)].task)), requiredCells = new Set(selected.flatMap(s => s.path.cells));
  const poolBuckets = [0, 0, 0, 0], poolTasks = taskNames.map(() => 0);
  for (const g of groups) { poolBuckets[g.bucket]++; poolTasks[g.task]++; }
  const bucketDistribution = poolBuckets.map(n => n / groups.length), taskDistribution = poolTasks.map(n => n / groups.length);
  const refs = new Int32Array(vocabulary.size), owners = new Int32Array(vocabulary.size), counts = new Int32Array(groups.length), losses = new Int32Array(selected.length), recovered = new Int32Array(selected.length);
  let work = 0, inputSwaps = 0, coverage = baseline.optimization.vocabulary, cost = baseline.optimization.tokens;
  let finalLengthTV = baseline.optimization.lengthTV, finalTaskTV = baseline.optimization.taskTV;
  for (let pass = 0; pass < Math.min(16, selected.length); pass++) {
    refs.fill(0); counts.fill(0); owners.fill(-1); losses.fill(0);
    const buckets = [0, 0, 0, 0], tasks = taskNames.map(() => 0), cells = new Map<string, number>();
    for (const s of selected) {
      const i = groupOf(s), g = groups[i];
      if (counts[i]++ === 0) { buckets[g.bucket]++; tasks[g.task]++; }
      for (const t of g.terms) { refs[t]++; if (++work % 1024 === 0) yield; }
      for (const c of new Set(s.path.cells)) cells.set(c, (cells.get(c) || 0) + 1);
    }
    const unique = counts.reduce((n, c) => n + Number(c > 0), 0);
    for (let j = 0; j < selected.length; j++) for (const t of groups[groupOf(selected[j])].terms) {
      if (refs[t] === 1) { owners[t] = j; losses[j]++; }
      if (++work % 1024 === 0) yield;
    }
    let best: { incoming: Selection; outgoing: number; agreementGain: number; gain: number; saving: number; lengthTV: number; taskTV: number } | undefined;
    for (let i = 0; i < groups.length; i++) {
      if (counts[i]) continue;
      const g = groups[i], row = g.rows[0];
      if (!g.score) continue;
      let added = 0; recovered.fill(0);
      for (const t of g.terms) { added += Number(refs[t] === 0); if (owners[t] >= 0) recovered[owners[t]]++; if (++work % 1024 === 0) yield; }
      for (let j = 0; j < selected.length; j++) {
        if (++work % 256 === 0) yield;
        const old = groups[groupOf(selected[j])];
        if (counts[groupOf(selected[j])] !== 1) continue;
        const agreementGain = g.score - old.score, gain = added - losses[j] + recovered[j], saving = old.cost - g.cost;
        if (agreementGain <= 1e-12 || cost - saving > baseline.optimization.tokenBudget || coverage + gain < baseline.optimization.vocabulary) continue;
        if (best && (agreementGain < best.agreementGain || (agreementGain === best.agreementGain && (gain < best.gain || (gain === best.gain && saving <= best.saving))))) continue;
        const nextBuckets = buckets.map((n, b) => n - Number(b === old.bucket) + Number(b === g.bucket));
        const nextTasks = tasks.map((n, t) => n - Number(t === old.task) + Number(t === g.task));
        if ([...requiredTasks].some(t => !nextTasks[t])) continue;
        const lengthTV = tv(nextBuckets, unique, bucketDistribution), taskTV = tv(nextTasks, unique, taskDistribution);
        if (baseline.optimization.distributionEnabled && (lengthTV > baseline.optimization.lengthLimit + 1e-9 || taskTV > baseline.optimization.taskLimit + 1e-9)) continue;
        const lost = [...requiredCells].filter(c => (cells.get(c) || 0) === 1 && selected[j].path.cells.includes(c));
        const path = [...row.paths].sort((a, b) => b.knownDimensions - a.knownDimensions || a.key.localeCompare(b.key)).find(p => lost.every(c => p.cells.includes(c)));
        if (!path) continue;
        best = { incoming: { key: row.key, path, reason: 'input_agreement' }, outgoing: j, agreementGain, gain, saving, lengthTV, taskTV };
      }
    }
    if (!best) break;
    selected[best.outgoing] = best.incoming; coverage += best.gain; cost -= best.saving;
    finalLengthTV = best.lengthTV; finalTaskTV = best.taskTV; inputSwaps++;
  }
  return { ...baseline, selected, counts: { ...baseline.counts, behaviorReserveUsed: selected.filter(s => s.reason === 'behavior').length, coveredCells: new Set(selected.flatMap(s => s.path.cells)).size }, optimization: { ...baseline.optimization, requestedPolicy: policy.version, effectivePolicy: policy.version, vocabulary: coverage, coverageGap: baseline.optimization.coverageUpperBound - coverage, tokens: cost, lengthTV: finalLengthTV, taskTV: finalTaskTV, completeStopped: inputSwaps ? 'post_agreement_exchange' : baseline.optimization.completeStopped }, agreement: { replacements: changed.replacements, comparisons: features.comparisons, inputSwaps, fallbackUnchanged: false } };
}

export function agreementSample(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = AGREEMENT_POLICY, experiment: FastExperiment = {}) {
  const steps = agreementSampleSteps(candidates, answers, limit, policy, experiment);
  let next = steps.next(); while (!next.done) next = steps.next(); return next.value;
}
