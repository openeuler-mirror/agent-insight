import { lengthBucket, type Candidate, type Policy } from './index';
import { type Selection } from './index';
import { INDEXED_POLICY, indexedSampleSteps, type BlockExperiment } from './budgeted-indexed';
import { consensusReplaceSteps } from './answer-consensus';
import { sharedAnswerFeaturesSteps } from './answer-shared';
import { tabuImproveSteps } from './budgeted-tabu';

export const REUSED_POLICY = Object.freeze({ ...INDEXED_POLICY, version: 'trace-coverage-v6.11' });
const tv = (counts: number[], size: number, pool: number[]) => counts.reduce((sum, n, i) => sum + Math.abs(n / size - pool[i]), 0) / 2;

export function* reusedPreparedSteps(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = REUSED_POLICY, experiment: BlockExperiment = {}) {
  if (policy.version !== REUSED_POLICY.version) throw new Error('INVALID_CONFIG');
  const baseline = yield* indexedSampleSteps(candidates, limit, policy, experiment);
  if (!baseline.optimization.feasible) return { result: { ...baseline, agreement: { replacements: 0, comparisons: 0, inputSwaps: 0, fallbackUnchanged: true, recallReplacements: 0, recallComparisons: 0 }, tabu: { trajectories: 0, steps: 0, negativeMoves: 0, plateauMoves: 0, aspirations: 0, bestUpdates: 0 } }, shared: undefined };
  const shared = yield* sharedAnswerFeaturesSteps(candidates, answers), features = shared.agreement;
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
  const agreed = { ...baseline, selected, counts: { ...baseline.counts, behaviorReserveUsed: selected.filter(s => s.reason === 'behavior').length, coveredCells: new Set(selected.flatMap(s => s.path.cells)).size }, optimization: { ...baseline.optimization, vocabulary: coverage, coverageGap: baseline.optimization.coverageUpperBound - coverage, tokens: cost, lengthTV: finalLengthTV, taskTV: finalTaskTV, completeStopped: inputSwaps ? 'post_agreement_exchange' : baseline.optimization.completeStopped }, agreement: { replacements: changed.replacements, comparisons: features.comparisons, inputSwaps, fallbackUnchanged: false } };
  const recalled = yield* consensusReplaceSteps(candidates, agreed.selected, shared.recall);
  const recalledResult = { ...agreed, selected: recalled.selected, counts: { ...agreed.counts, behaviorReserveUsed: recalled.selected.filter(s => s.reason === 'behavior').length, coveredCells: new Set(recalled.selected.flatMap(s => s.path.cells)).size }, agreement: { ...agreed.agreement, recallReplacements: recalled.replacements, recallComparisons: shared.recall.comparisons } };
  const costBound = candidates.map(c => c.lexical!.tokenCount).sort((a, b) => a - b).slice(0, recalled.selected.length).reduce((sum, n) => sum + n, 0);
  if (recalledResult.optimization.vocabulary === recalledResult.optimization.coverageUpperBound && recalledResult.optimization.tokens === costBound) return { result: { ...recalledResult, tabu: { trajectories: 0, steps: 0, negativeMoves: 0, plateauMoves: 0, aspirations: 0, bestUpdates: 0, stopped: 'coverage_and_cost_bound' } }, shared };
  const explored = yield* tabuImproveSteps(candidates, recalled.selected, shared.recall, { seed: policy.seed, tokenBudget: baseline.optimization.tokenBudget, distributionEnabled: baseline.optimization.distributionEnabled });
  const result = { ...recalledResult, selected: explored.selected, counts: { ...recalledResult.counts, behaviorReserveUsed: explored.selected.filter(s => s.reason === 'behavior').length, coveredCells: new Set(explored.selected.flatMap(s => s.path.cells)).size }, optimization: { ...recalledResult.optimization, vocabulary: explored.vocabulary, coverageGap: baseline.optimization.coverageUpperBound - explored.vocabulary, tokens: explored.tokens, lengthTV: explored.lengthTV, taskTV: explored.taskTV, completeStopped: explored.tabu.bestUpdates ? 'post_tabu_search' : recalledResult.optimization.completeStopped }, tabu: explored.tabu };
  return { result, shared };
}

export function* reusedSampleSteps(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = REUSED_POLICY, experiment: BlockExperiment = {}) {
  return (yield* reusedPreparedSteps(candidates, answers, limit, policy, experiment)).result;
}

export function reusedSample(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = REUSED_POLICY, experiment: BlockExperiment = {}) {
  const steps = reusedSampleSteps(candidates, answers, limit, policy, experiment);
  let next = steps.next(); while (!next.done) next = steps.next(); return next.value;
}
