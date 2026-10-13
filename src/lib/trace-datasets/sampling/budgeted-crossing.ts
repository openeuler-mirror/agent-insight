import { hash, lengthBucket, type Candidate, type Policy, type Selection } from './index';
import { type AgreementFeatures } from './answer-consensus';
import { PRICED_POLICY, pricedPreparedSteps } from './budgeted-priced';
import { type BlockExperiment } from './budgeted-priced-core';

export const CROSSING_POLICY = Object.freeze({ ...PRICED_POLICY, version: 'trace-coverage-v6.15' });
const tv = (counts: number[], size: number, pool: number[]) => counts.reduce((sum, n, i) => sum + Math.abs(n / size - pool[i]), 0) / 2;
type Settings = { seed: number; tokenBudget: number; distributionEnabled: boolean };

export function* crossingImproveSteps(candidates: Candidate[], initial: Selection[], features: AgreementFeatures, settings: Settings) {
  const byKey = new Map(candidates.map(c => [c.key, c])), vocabulary = new Map<string, number>();
  const taskNames = [...new Set(candidates.map(c => c.task))].sort(); if (!taskNames.includes('unknown')) taskNames.push('unknown');
  let work = 0;
  const groups: { key: string; rows: Candidate[]; terms: Uint32Array; cost: number; bucket: number; task: number }[] = [];
  for (const [key, rows] of [...features.groups].sort(([a], [b]) => a.localeCompare(b))) {
    const tasks = [...new Set(rows.map(r => r.task).filter(t => t !== 'unknown'))], termIds: number[] = [];
    for (const term of rows[0].lexical!.terms) {
      if (!vocabulary.has(term)) vocabulary.set(term, vocabulary.size);
      termIds.push(vocabulary.get(term)!); if (++work % 1024 === 0) yield;
    }
    groups.push({ key, rows: [...rows].sort((a, b) => features.scores.get(b.key)! - features.scores.get(a.key)! || a.key.localeCompare(b.key)), terms: Uint32Array.from(termIds), cost: rows[0].lexical!.tokenCount, bucket: lengthBucket(rows[0].lexical!.tokenCount), task: taskNames.indexOf(tasks.length === 1 ? tasks[0] : 'unknown') });
  }
  const byInput = new Map(groups.map((g, i) => [g.key, i]));
  const groupOf = (s: Selection) => byInput.get(byKey.get(s.key)!.inputKey)!;
  const requiredTasks = new Set(initial.map(s => groups[groupOf(s)].task)), requiredCells = new Set(initial.flatMap(s => s.path.cells));
  const poolBuckets = [0, 0, 0, 0], poolTasks = taskNames.map(() => 0);
  for (const g of groups) { poolBuckets[g.bucket]++; poolTasks[g.task]++; }
  const bucketDistribution = poolBuckets.map(n => n / groups.length), taskDistribution = poolTasks.map(n => n / groups.length);
  const refs = new Int32Array(vocabulary.size), owners = new Int32Array(vocabulary.size), counts = new Int32Array(groups.length), losses = new Int32Array(initial.length), recovered = new Int32Array(initial.length);
  const initialTerms = new Set<number>(); let initialCost = 0;
  for (const s of initial) { const g = groups[groupOf(s)]; initialCost += g.cost; for (const t of g.terms) { initialTerms.add(t); if (++work % 1024 === 0) yield; } }
  if (initialCost > settings.tokenBudget) throw new Error('INFEASIBLE_START');
  let bestSelected = [...initial], bestCoverage = initialTerms.size, bestCost = initialCost;
  let steps = 0, negativeMoves = 0, plateauMoves = 0, aspirations = 0, bestUpdates = 0, overBudgetSteps = 0;
  const ranks = groups.map(g => hash(['priced-crossing-order', settings.seed, g.key]));
  const order = groups.map((_, i) => i).sort((a, b) => ranks[a].localeCompare(ranks[b]) || groups[a].key.localeCompare(groups[b].key));
  const priority = new Int32Array(groups.length); order.forEach((i, rank) => { priority[i] = rank; });
  for (const trajectory of [0, 1]) {
    const selected = [...initial], tabuUntil = new Int32Array(groups.length);
    let coverage = initialTerms.size, cost = initialCost, price = (trajectory === 0 ? .5 : 2) * initialTerms.size / Math.max(1, settings.tokenBudget);
    for (let step = 0; step < Math.min(32, initial.length); step++) {
      refs.fill(0); owners.fill(-1); counts.fill(0); losses.fill(0);
      const buckets = [0, 0, 0, 0], tasks = taskNames.map(() => 0), cells = new Map<string, number>();
      for (const s of selected) {
        const i = groupOf(s), g = groups[i];
        if (counts[i]++ === 0) { buckets[g.bucket]++; tasks[g.task]++; }
        for (const t of g.terms) { refs[t]++; if (++work % 1024 === 0) yield; }
        for (const cell of new Set(s.path.cells)) cells.set(cell, (cells.get(cell) || 0) + 1);
      }
      const unique = counts.reduce((n, v) => n + Number(v > 0), 0), lengthLimit = Math.max(.1, 2 / unique), taskLimit = Math.max(.2, 2 / unique);
      const outgoing = selected.map((s, index) => ({ selection: s, group: groupOf(s), index })).sort((a, b) => a.selection.key.localeCompare(b.selection.key));
      for (let j = 0; j < outgoing.length; j++) for (const t of groups[outgoing[j].group].terms) {
        if (refs[t] === 1) { owners[t] = j; losses[j]++; }
        if (++work % 1024 === 0) yield;
      }
      const distributionCache = new Map<number, boolean>();
      const allowedDistribution = (a: typeof groups[number], b: typeof groups[number]) => {
        const code = ((a.bucket * 4 + b.bucket) * taskNames.length + a.task) * taskNames.length + b.task;
        let allowed = distributionCache.get(code);
        if (allowed === undefined) {
          const nextBuckets = buckets.map((n, i) => n - Number(i === a.bucket) + Number(i === b.bucket));
          const nextTasks = tasks.map((n, i) => n - Number(i === a.task) + Number(i === b.task));
          allowed = [...requiredTasks].every(t => nextTasks[t] > 0) && (!settings.distributionEnabled || (tv(nextBuckets, unique, bucketDistribution) <= lengthLimit + 1e-9 && tv(nextTasks, unique, taskDistribution) <= taskLimit + 1e-9));
          distributionCache.set(code, allowed);
        }
        return allowed;
      };
      type Proposal = { incoming: Selection; incomingGroup: number; outgoing: number; outgoingGroup: number; gain: number; saving: number; aspiration: boolean; score: number };
      const scan = (i: number, added: number, current: Proposal | undefined): Proposal | undefined => {
        const g = groups[i]; let best = current;
        for (let j = 0; j < outgoing.length; j++) {
          const old = groups[outgoing[j].group]; if (counts[outgoing[j].group] !== 1) continue;
          const gain = added - losses[j] + recovered[j], saving = old.cost - g.cost;
          if (cost - saving > Math.floor(1.25 * settings.tokenBudget)) continue;
          const score = gain + price * saving;
          const taboo = tabuUntil[i] > step, aspiration = taboo && cost - saving <= settings.tokenBudget && coverage + gain > bestCoverage;
          if (taboo && !aspiration) continue;
          if (best && (score < best.score || (score === best.score && (gain < best.gain || (gain === best.gain && (saving < best.saving || (saving === best.saving && priority[i] >= priority[best.incomingGroup]))))))) continue;
          if (!allowedDistribution(old, g)) continue;
          const lost = [...requiredCells].filter(c => (cells.get(c) || 0) === 1 && outgoing[j].selection.path.cells.includes(c));
          let incoming: Selection | undefined;
          for (const row of g.rows) {
            const path = [...row.paths].sort((a, b) => b.knownDimensions - a.knownDimensions || a.key.localeCompare(b.key)).find(p => lost.every(c => p.cells.includes(c)));
            if (path) { incoming = { key: row.key, path, reason: 'priced_crossing' }; break; }
          }
          if (incoming) best = { incoming, incomingGroup: i, outgoing: outgoing[j].index, outgoingGroup: outgoing[j].group, gain, saving, aspiration, score };
        }
        return best;
      };
      const small = (i: number, proposal: Proposal | undefined) => {
        recovered.fill(0); let added = 0;
        for (const t of groups[i].terms) { added += Number(refs[t] === 0); if (owners[t] >= 0) recovered[owners[t]]++; }
        return scan(i, added, proposal);
      };
      let proposal: Proposal | undefined, scanned = 0;
      for (let i = 0; i < groups.length; i++) {
        if (counts[i]) continue;
        if (groups[i].terms.length <= 1024) proposal = small(i, proposal);
        else {
          recovered.fill(0); let added = 0;
          for (const t of groups[i].terms) { added += Number(refs[t] === 0); if (owners[t] >= 0) recovered[owners[t]]++; if (++work % 1024 === 0) yield; }
          proposal = scan(i, added, proposal);
        }
        if (++scanned % 8 === 0) yield;
      }
      if (!proposal) break;
      selected[proposal.outgoing] = proposal.incoming; tabuUntil[proposal.outgoingGroup] = step + 8;
      coverage += proposal.gain; cost -= proposal.saving; steps++;
      overBudgetSteps += Number(cost > settings.tokenBudget);
      price *= Math.exp(.5 * (cost / Math.max(1, settings.tokenBudget) - 1));
      negativeMoves += Number(proposal.gain < 0); plateauMoves += Number(proposal.gain === 0); aspirations += Number(proposal.aspiration);
      if (cost <= settings.tokenBudget && (coverage > bestCoverage || (coverage === bestCoverage && cost < bestCost))) { bestCoverage = coverage; bestCost = cost; bestSelected = [...selected]; bestUpdates++; }
    }
  }
  const unique = new Set(bestSelected.map(groupOf)), buckets = [0, 0, 0, 0], tasks = taskNames.map(() => 0);
  for (const i of unique) { buckets[groups[i].bucket]++; tasks[groups[i].task]++; }
  return { selected: bestSelected, vocabulary: bestCoverage, tokens: bestCost, lengthTV: tv(buckets, unique.size, bucketDistribution), taskTV: tv(tasks, unique.size, taskDistribution), crossing: { overBudgetSteps, internalBudgetRatio: 1.25, trajectories: 2, stepLimit: Math.min(32, initial.length), tenure: 7, steps, negativeMoves, plateauMoves, aspirations, bestUpdates } };
}

export function* crossingSampleSteps(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = CROSSING_POLICY, experiment: BlockExperiment = {}) {
  if (policy.version !== CROSSING_POLICY.version) throw new Error('INVALID_CONFIG');
  const prepared = yield* pricedPreparedSteps(candidates, answers, limit, { ...policy, version: PRICED_POLICY.version }, experiment), baseline = prepared.result;
  const costBound = candidates.map(c => c.lexical!.tokenCount).sort((a, b) => a - b).slice(0, baseline.selected.length).reduce((sum, n) => sum + n, 0);
  if (!prepared.features || (baseline.optimization.vocabulary === baseline.optimization.coverageUpperBound && baseline.optimization.tokens === costBound)) return { ...baseline, optimization: { ...baseline.optimization, requestedPolicy: policy.version, effectivePolicy: baseline.optimization.feasible ? policy.version : baseline.optimization.effectivePolicy }, crossing: { trajectories: 0, steps: 0, negativeMoves: 0, plateauMoves: 0, aspirations: 0, bestUpdates: 0, overBudgetSteps: 0, internalBudgetRatio: 1.25 } };
  const changed = yield* crossingImproveSteps(candidates, baseline.selected, prepared.features, { seed: policy.seed, tokenBudget: baseline.optimization.tokenBudget, distributionEnabled: baseline.optimization.distributionEnabled });
  return { ...baseline, selected: changed.selected, counts: { ...baseline.counts, behaviorReserveUsed: changed.selected.filter(s => s.reason === 'behavior').length, coveredCells: new Set(changed.selected.flatMap(s => s.path.cells)).size }, optimization: { ...baseline.optimization, requestedPolicy: policy.version, effectivePolicy: policy.version, vocabulary: changed.vocabulary, coverageGap: baseline.optimization.coverageUpperBound - changed.vocabulary, tokens: changed.tokens, lengthTV: changed.lengthTV, taskTV: changed.taskTV, completeStopped: changed.crossing.bestUpdates ? 'post_priced_crossing' : baseline.optimization.completeStopped }, crossing: changed.crossing };
}

export function crossingSample(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = CROSSING_POLICY, experiment: BlockExperiment = {}) {
  const steps = crossingSampleSteps(candidates, answers, limit, policy, experiment);
  let next = steps.next(); while (!next.done) next = steps.next(); return next.value;
}
