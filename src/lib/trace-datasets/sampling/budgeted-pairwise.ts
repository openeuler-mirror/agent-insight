import { lengthBucket, type Candidate, type Policy, type Selection } from './index';
import { type AgreementFeatures } from './answer-consensus';
import { WEIGHTED_POLICY, weightedPreparedSteps } from './answer-weighted';
import { type BlockExperiment } from './budgeted-indexed';

export const PAIRWISE_POLICY = Object.freeze({ ...WEIGHTED_POLICY, version: 'trace-coverage-v6.13' });
const tv = (counts: number[], size: number, pool: number[]) => counts.reduce((sum, n, i) => sum + Math.abs(n / size - pool[i]), 0) / 2;
type Settings = { tokenBudget: number; distributionEnabled: boolean; coverageUpperBound: number };

export function* pairwiseImproveSteps(candidates: Candidate[], initial: Selection[], features: AgreementFeatures, settings: Settings) {
  const byKey = new Map(candidates.map(c => [c.key, c])), vocabulary = new Map<string, number>();
  const taskNames = [...new Set(candidates.map(c => c.task))].sort(); if (!taskNames.includes('unknown')) taskNames.push('unknown');
  const groups: { key: string; rows: Candidate[]; terms: Set<number>; cost: number; bucket: number; task: number }[] = [];
  let work = 0;
  for (const [key, rows] of [...features.groups].sort(([a], [b]) => a.localeCompare(b))) {
    const terms = new Set<number>(), tasks = [...new Set(rows.map(r => r.task).filter(t => t !== 'unknown'))];
    for (const term of rows[0].lexical!.terms) {
      if (!vocabulary.has(term)) vocabulary.set(term, vocabulary.size);
      terms.add(vocabulary.get(term)!); if (++work % 1024 === 0) yield;
    }
    groups.push({ key, rows: [...rows].sort((a, b) => features.scores.get(b.key)! - features.scores.get(a.key)! || a.key.localeCompare(b.key)), terms, cost: rows[0].lexical!.tokenCount, bucket: lengthBucket(rows[0].lexical!.tokenCount), task: taskNames.indexOf(tasks.length === 1 ? tasks[0] : 'unknown') });
  }
  const byInput = new Map(groups.map((g, i) => [g.key, i])), groupOf = (s: Selection) => byInput.get(byKey.get(s.key)!.inputKey)!;
  const requiredTasks = new Set(initial.map(s => groups[groupOf(s)].task)), requiredCells = new Set(initial.flatMap(s => s.path.cells));
  const poolBuckets = [0, 0, 0, 0], poolTasks = taskNames.map(() => 0);
  for (const g of groups) { poolBuckets[g.bucket]++; poolTasks[g.task]++; }
  const bucketDistribution = poolBuckets.map(n => n / groups.length), taskDistribution = poolTasks.map(n => n / groups.length);
  const selected = [...initial], refs = new Int32Array(vocabulary.size), owners = new Int32Array(vocabulary.size), counts = new Int32Array(groups.length), losses = new Int32Array(groups.length), added = new Int32Array(groups.length);
  const costBound = candidates.map(c => c.lexical!.tokenCount).sort((a, b) => a - b).slice(0, initial.length).reduce((sum, n) => sum + n, 0);
  let passes = 0, accepted = 0, testedPairs = 0, cost = 0, coverage = 0, stopped = 'pass_limit';
  let finalLengthTV = 0, finalTaskTV = 0;
  for (let pass = 0; pass <= 4; pass++) {
    refs.fill(0); owners.fill(-1); counts.fill(0); losses.fill(0); added.fill(0); cost = 0;
    const buckets = [0, 0, 0, 0], tasks = taskNames.map(() => 0), cells = new Map<string, number>();
    for (const s of selected) {
      const i = groupOf(s), g = groups[i]; cost += g.cost;
      if (counts[i]++ === 0) { buckets[g.bucket]++; tasks[g.task]++; }
      for (const term of g.terms) { refs[term]++; owners[term] = i; if (++work % 1024 === 0) yield; }
      for (const cell of new Set(s.path.cells)) cells.set(cell, (cells.get(cell) || 0) + 1);
    }
    coverage = refs.reduce((sum, n) => sum + Number(n > 0), 0);
    const unique = counts.reduce((sum, n) => sum + Number(n > 0), 0), lengthLimit = Math.max(.1, 2 / unique), taskLimit = Math.max(.2, 2 / unique);
    finalLengthTV = tv(buckets, unique, bucketDistribution); finalTaskTV = tv(tasks, unique, taskDistribution);
    if (cost > settings.tokenBudget) throw new Error('INFEASIBLE_START');
    if (coverage === settings.coverageUpperBound && cost === costBound) { stopped = 'coverage_and_cost_bound'; break; }
    if (pass === 4) break;
    const removable = selected.map((s, index) => ({ s, index, group: groupOf(s) })).filter(p => counts[p.group] === 1);
    if (removable.length < 2 || groups.length - unique < 2) { stopped = 'insufficient_pairs'; break; }
    passes++;
    for (const p of removable) for (const term of groups[p.group].terms) { losses[p.group] += Number(refs[term] === 1); if (++work % 1024 === 0) yield; }
    const outgoing = [...removable].sort((a, b) => losses[a.group] - losses[b.group] || groups[b.group].cost - groups[a.group].cost || groups[a.group].key.localeCompare(groups[b.group].key)).slice(0, 24);
    const rankings: { i: number; score: number }[] = [];
    for (let i = 0; i < groups.length; i++) {
      if (counts[i]) continue;
      const recovered = new Map<number, number>();
      for (const term of groups[i].terms) {
        if (refs[term] === 0) added[i]++;
        else if (refs[term] === 1) recovered.set(owners[term], (recovered.get(owners[term]) || 0) + 1);
        if (++work % 1024 === 0) yield;
      }
      let score = -Infinity;
      for (const p of removable) score = Math.max(score, added[i] - losses[p.group] + (recovered.get(p.group) || 0));
      rankings.push({ i, score }); if (++work % 128 === 0) yield;
    }
    const ranked = (rows: typeof rankings, power: number, take: number) => [...rows].sort((a, b) => b.score / Math.max(1, groups[b.i].cost) ** power - a.score / Math.max(1, groups[a.i].cost) ** power || groups[a.i].key.localeCompare(groups[b.i].key)).slice(0, take).map(r => r.i);
    const shortlist = [...new Set([...ranked(rankings, 0, 32), ...ranked(rankings, .5, 32)])].sort((a, b) => groups[a].key.localeCompare(groups[b].key));
    type Proposal = { a: number; b: number; incoming: [Selection, Selection]; gain: number; saving: number };
    let best: Proposal | undefined;
    const choices = new Map<number, { selected: Selection; score: number }[]>();
    for (const i of shortlist) {
      const list = groups[i].rows.flatMap(row => row.paths.map(path => ({ selected: { key: row.key, path, reason: 'pairwise_exchange' }, score: features.scores.get(row.key)! })));
      list.sort((a, b) => b.score - a.score || a.selected.key.localeCompare(b.selected.key) || a.selected.path.key.localeCompare(b.selected.path.key)); choices.set(i, list);
    }
    for (let a = 0; a < outgoing.length; a++) for (let b = a + 1; b < outgoing.length; b++) {
      const oldA = groups[outgoing[a].group], oldB = groups[outgoing[b].group], lost = new Set<number>();
      for (const term of oldA.terms) { if (refs[term] === 1 || (refs[term] === 2 && oldB.terms.has(term))) lost.add(term); if (++work % 1024 === 0) yield; }
      for (const term of oldB.terms) { if (refs[term] === 1) lost.add(term); if (++work % 1024 === 0) yield; }
      const marginal = new Map<number, number>(), rows: typeof rankings = [];
      for (const i of shortlist) {
        let score = added[i]; for (const term of lost) { score += Number(groups[i].terms.has(term)); if (++work % 1024 === 0) yield; }
        marginal.set(i, score); rows.push({ i, score });
      }
      const ins = [...new Set([...ranked(rows, 0, 8), ...ranked(rows, .5, 8)])].sort((i, j) => groups[i].key.localeCompare(groups[j].key));
      const lostCells = [...requiredCells].filter(c => (cells.get(c) || 0) - Number(outgoing[a].s.path.cells.includes(c)) - Number(outgoing[b].s.path.cells.includes(c)) <= 0);
      for (let x = 0; x < ins.length; x++) for (let y = x + 1; y < ins.length; y++) {
        testedPairs++; if (++work % 256 === 0) yield;
        const i = ins[x], j = ins[y], g = groups[i], h = groups[j], saving = oldA.cost + oldB.cost - g.cost - h.cost;
        const upper = marginal.get(i)! + marginal.get(j)! - lost.size;
        if (cost - saving > settings.tokenBudget || upper < 0 || (upper === 0 && saving <= 0) || (best && (upper < best.gain || (upper === best.gain && saving <= best.saving)))) continue;
        const nextBuckets = buckets.map((n, k) => n - Number(k === oldA.bucket) - Number(k === oldB.bucket) + Number(k === g.bucket) + Number(k === h.bucket));
        const nextTasks = tasks.map((n, k) => n - Number(k === oldA.task) - Number(k === oldB.task) + Number(k === g.task) + Number(k === h.task));
        if ([...requiredTasks].some(t => nextTasks[t] === 0)) continue;
        if (settings.distributionEnabled && (tv(nextBuckets, unique, bucketDistribution) > lengthLimit + 1e-9 || tv(nextTasks, unique, taskDistribution) > taskLimit + 1e-9)) continue;
        let overlap = 0;
        const [small, large] = g.terms.size <= h.terms.size ? [g.terms, h.terms] : [h.terms, g.terms];
        for (const term of small) { if ((refs[term] === 0 || lost.has(term)) && large.has(term)) overlap++; if (++work % 1024 === 0) yield; }
        const gain = upper - overlap;
        if (gain < 0 || (gain === 0 && saving <= 0) || (best && (gain < best.gain || (gain === best.gain && saving <= best.saving)))) continue;
        let incoming: [Selection, Selection] | undefined, bestScore = -Infinity;
        for (const first of choices.get(i)!) for (const second of choices.get(j)!) {
          if (++work % 256 === 0) yield;
          const score = first.score + second.score;
          if (score <= bestScore || !lostCells.every(c => first.selected.path.cells.includes(c) || second.selected.path.cells.includes(c))) continue;
          incoming = [first.selected, second.selected]; bestScore = score;
        }
        if (incoming) best = { a: outgoing[a].index, b: outgoing[b].index, incoming, gain, saving };
      }
      yield;
    }
    if (!best) { stopped = 'bounded_pair_local_optimum'; break; }
    selected[best.a] = best.incoming[0]; selected[best.b] = best.incoming[1]; accepted++;
  }
  return { selected, vocabulary: coverage, tokens: cost, lengthTV: finalLengthTV, taskTV: finalTaskTV, pairwise: { passes, accepted, testedPairs, stopped } };
}

export function* pairwiseSampleSteps(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = PAIRWISE_POLICY, experiment: BlockExperiment = {}) {
  if (policy.version !== PAIRWISE_POLICY.version) throw new Error('INVALID_CONFIG');
  const prepared = yield* weightedPreparedSteps(candidates, answers, limit, { ...policy, version: WEIGHTED_POLICY.version }, experiment), baseline = prepared.result;
  if (!prepared.features) return { ...baseline, optimization: { ...baseline.optimization, requestedPolicy: policy.version }, pairwise: { passes: 0, accepted: 0, testedPairs: 0, stopped: 'fallback' } };
  const changed = yield* pairwiseImproveSteps(candidates, baseline.selected, prepared.features, { tokenBudget: baseline.optimization.tokenBudget, distributionEnabled: baseline.optimization.distributionEnabled, coverageUpperBound: baseline.optimization.coverageUpperBound });
  return { ...baseline, selected: changed.selected, counts: { ...baseline.counts, behaviorReserveUsed: changed.selected.filter(s => s.reason === 'behavior').length, coveredCells: new Set(changed.selected.flatMap(s => s.path.cells)).size }, optimization: { ...baseline.optimization, requestedPolicy: policy.version, effectivePolicy: policy.version, vocabulary: changed.vocabulary, coverageGap: baseline.optimization.coverageUpperBound - changed.vocabulary, tokens: changed.tokens, lengthTV: changed.lengthTV, taskTV: changed.taskTV, completeStopped: changed.pairwise.accepted ? 'post_pairwise_search' : baseline.optimization.completeStopped }, pairwise: changed.pairwise };
}

export function pairwiseSample(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = PAIRWISE_POLICY, experiment: BlockExperiment = {}) {
  const steps = pairwiseSampleSteps(candidates, answers, limit, policy, experiment);
  let next = steps.next(); while (!next.done) next = steps.next(); return next.value;
}
