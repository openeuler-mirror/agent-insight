import { COVERAGE_POLICY, LEGACY_POLICY, hash, lengthBucket, sampleSteps, type Candidate, type Path, type Policy, type Selection } from './index';

export const COMPLETE_POLICY = Object.freeze({ ...COVERAGE_POLICY, version: 'trace-coverage-v6.4' });
export type CompleteExperiment = { budgetRatio?: number; swaps?: boolean; pairSwaps?: boolean; restarts?: boolean; distribution?: boolean; repair?: boolean; efficiencySwaps?: boolean; upperBound?: boolean; budgetBridge?: boolean; pricedStarts?: boolean; neighborhood?: boolean; completeExchange?: boolean; plateau?: boolean };
type Group = { key: string; rows: Candidate[]; terms: Uint32Array; cost: number; bucket: number; task: number };
type Pick = { row: Candidate; group: number; path: Path; reason: string };
type State = { picks: Pick[]; groups: Int32Array; refs: Int32Array; gains: Int32Array; buckets: number[]; tasks: number[]; cells: Map<string, number>; cost: number; vocabulary: number; unique: number; oneSwaps: number; pairSwaps: number };
const tv = (counts: number[], size: number, distribution: number[]) => counts.reduce((sum, n, i) => sum + Math.abs((size ? n / size : 0) - distribution[i]), 0) / 2;

export function* completeSampleSteps(candidates: Candidate[], limit: number, policy: Policy = COMPLETE_POLICY, experiment: CompleteExperiment = {}) {
  const ratio = experiment.budgetRatio ?? 1.1;
  if (!candidates.length) throw new Error('NO_VALID_SAMPLES');
  if (policy.version !== COMPLETE_POLICY.version || !Number.isInteger(policy.seed) || !Number.isFinite(policy.rho) || policy.rho < 0 || policy.rho > 1 || !Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isFinite(ratio) || ratio < 1 || ratio > 1.2) throw new Error('INVALID_CONFIG');
  const total = Math.min(limit, candidates.length), byKey = new Map<string, number>();
  const grouped = new Map<string, Candidate[]>(), vocabulary = new Map<string, number>();
  const taskNames = [...new Set(candidates.map(c => c.task))].sort();
  const groups: Group[] = [], frequency: number[] = [];
  const rankCache = new Map<string, string>();
  const rank = (phase: string, key: string) => {
    const id = `${phase}:${key}`;
    let value = rankCache.get(id);
    if (!value) { value = hash(['trace-coverage-v6', policy.seed, phase, key]); rankCache.set(id, value); }
    return value;
  };
  const compare = (phase: string, a: string, b: string) => rank(phase, a).localeCompare(rank(phase, b)) || a.localeCompare(b);
  let work = 0;
  for (const row of candidates) {
    if (byKey.has(row.key) || !row.paths.length || !row.lexical || !Number.isSafeInteger(row.lexical.tokenCount) || row.lexical.tokenCount < row.lexical.terms.length) throw new Error('SOURCE_CORRUPT');
    byKey.set(row.key, -1);
    const list = grouped.get(row.inputKey) || []; list.push(row); grouped.set(row.inputKey, list);
    if (++work % 256 === 0) yield;
  }
  const baseline = yield* sampleSteps(candidates, limit, { ...policy, version: COVERAGE_POLICY.version });
  if (!taskNames.includes('unknown')) taskNames.push('unknown');
  const poolBuckets = [0, 0, 0, 0], poolTasks = taskNames.map(() => 0);
  for (const key of [...grouped.keys()].sort()) {
    const rows = grouped.get(key)!.sort((a, b) => compare('answer', a.key, b.key));
    const feature = rows[0].lexical!, terms: number[] = [];
    const uniqueTerms = new Set(feature.terms);
    if (uniqueTerms.size !== feature.terms.length) throw new Error('SOURCE_CORRUPT');
    for (const row of rows) {
      const other = row.lexical!;
      if (other !== feature && (other.tokenCount !== feature.tokenCount || other.terms.length !== uniqueTerms.size || new Set(other.terms).size !== uniqueTerms.size || other.terms.some(term => !uniqueTerms.has(term)))) throw new Error('SOURCE_CORRUPT');
      byKey.set(row.key, groups.length);
    }
    for (const term of uniqueTerms) {
      if (++work % 1024 === 0) yield;
      let id = vocabulary.get(term);
      if (id === undefined) { id = vocabulary.size; vocabulary.set(term, id); frequency.push(0); }
      terms.push(id); frequency[id]++;
    }
    const tasks = [...new Set(rows.map(c => c.task).filter(t => t !== 'unknown'))];
    const task = taskNames.indexOf(tasks.length === 1 ? tasks[0] : 'unknown'), bucket = lengthBucket(feature.tokenCount);
    groups.push({ key, rows, terms: Uint32Array.from(terms), cost: feature.tokenCount, bucket, task }); poolBuckets[bucket]++; poolTasks[task]++;
  }
  const sharedTerms = frequency.filter(n => n > 1).length;
  const largest = (values: number[]) => values.sort((a, b) => b - a).slice(0, total).reduce((a, b) => a + b, 0);
  const coverageUpperBound = Math.min(vocabulary.size, largest(groups.map(g => g.terms.length)), sharedTerms + largest(groups.map(g => g.terms.reduce((n, term) => n + Number(frequency[term] === 1), 0))));
  const groupCount = groups.length, baseTokens = total * groups.reduce((n, g) => n + g.cost, 0) / groupCount;
  const tokenBudget = Math.floor(baseTokens * ratio + 1e-9);
  const bucketDistribution = poolBuckets.map(n => n / groupCount), taskDistribution = poolTasks.map(n => n / groupCount);
  const resolve = (s: Selection): Pick => ({ row: candidates.find(c => c.key === s.key)!, group: byKey.get(s.key)!, path: s.path, reason: s.reason });
  const baselinePicks = baseline.selected.map(resolve);
  const forced = baselinePicks.filter(p => p.reason === 'task_floor' || p.reason === 'behavior');
  const requiredTasks = new Set(forced.filter(p => p.reason === 'task_floor').map(p => groups[p.group].task));
  const requiredCells = new Set(forced.flatMap(p => p.path.cells));
  const distributionEnabled = experiment.distribution !== false;
  const lengthLimit = (q: number) => Math.max(.10, 2 / Math.max(1, q));
  const taskLimit = (q: number) => Math.max(.20, 2 / Math.max(1, q));
  const initialRefs = new Set<number>(), initialBuckets = [0, 0, 0, 0], initialTasks = poolTasks.map(() => 0), initialGroups = new Set<number>(), initialCells = new Set<string>();
  let initialCost = 0;
  for (const p of baselinePicks) {
    const g = groups[p.group]; initialCost += g.cost;
    if (!initialGroups.has(p.group)) { initialGroups.add(p.group); initialBuckets[g.bucket]++; initialTasks[g.task]++; }
    for (const t of g.terms) { initialRefs.add(t); if (++work % 1024 === 0) yield; }
    for (const cell of p.path.cells) initialCells.add(cell);
  }
  const costLowerBound = candidates.map(c => c.lexical!.tokenCount).sort((a, b) => a - b).slice(0, total).reduce((a, b) => a + b, 0);
  const costSaturated = (cost: number) => experiment.completeExchange === false || experiment.plateau === false || experiment.swaps === false || cost === costLowerBound;
  const initialLengthTV = tv(initialBuckets, initialGroups.size, bucketDistribution), initialTaskTV = tv(initialTasks, initialGroups.size, taskDistribution);
  if (experiment.upperBound !== false && initialRefs.size === coverageUpperBound && costSaturated(initialCost) && initialCost <= tokenBudget && (!distributionEnabled || (initialLengthTV <= lengthLimit(initialGroups.size) + 1e-9 && initialTaskTV <= taskLimit(initialGroups.size) + 1e-9))) {
    return {
      selected: baselinePicks.map(p => ({ key: p.row.key, path: p.path, reason: p.reason })),
      counts: { candidates: candidates.length, inputs: groupCount, generated: baselinePicks.length, behaviorReserve: baseline.counts.behaviorReserve, behaviorReserveUsed: baselinePicks.filter(p => p.reason === 'behavior').length, coveredCells: initialCells.size },
      optimization: { requestedPolicy: policy.version, effectivePolicy: policy.version, fallbackReason: null, feasible: true, tokenBudget, baseTokens, tokens: initialCost, vocabulary: initialRefs.size, lengthTV: initialLengthTV, taskTV: initialTaskTV, lengthLimit: lengthLimit(initialGroups.size), taskLimit: taskLimit(initialGroups.size), distributionEnabled, evaluated: 1, feasibleCount: 1, oneSwaps: 0, pairSwaps: 0, repairSwaps: 0, repairAttempts: 0, efficiencySwaps: 0, bridgeAttempts: 0, bridgeAccepted: 0, coverageUpperBound, coverageGap: 0, neighborhoodAttempts: 0, neighborhoodAccepted: 0, completePasses: 0, completeSwaps: 0, plateauSwaps: 0, completeStopped: 'coverage_bound', searchIndexBuilt: false },
    };
  }
  const postings = frequency.map(n => new Uint32Array(n)), positions = new Uint32Array(frequency.length);
  for (let i = 0; i < groups.length; i++) for (const term of groups[i].terms) {
    postings[term][positions[term]++] = i;
    if (++work % 1024 === 0) yield;
  }
  const vocabularySize = vocabulary.size;
  vocabulary.clear(); grouped.clear(); initialRefs.clear();
  const fresh = (): State => ({ picks: [], groups: new Int32Array(groupCount), refs: new Int32Array(vocabularySize), gains: Int32Array.from(groups, g => g.terms.length), buckets: [0, 0, 0, 0], tasks: poolTasks.map(() => 0), cells: new Map(), cost: 0, vocabulary: 0, unique: 0, oneSwaps: 0, pairSwaps: 0 });
  const change = function* (state: State, pick: Pick, direction: 1 | -1): Generator<void, void> {
    const g = groups[pick.group], before = state.groups[pick.group];
    state.groups[pick.group] += direction; state.cost += direction * g.cost;
    if ((direction === 1 && before === 0) || (direction === -1 && before === 1)) {
      state.unique += direction; state.buckets[g.bucket] += direction; state.tasks[g.task] += direction;
    }
    for (const cell of new Set(pick.path.cells)) {
      const next = (state.cells.get(cell) || 0) + direction;
      if (next) state.cells.set(cell, next); else state.cells.delete(cell);
    }
    for (const term of g.terms) {
      const old = state.refs[term]; state.refs[term] += direction;
      if ((direction === 1 && old === 0) || (direction === -1 && old === 1)) {
        state.vocabulary += direction;
        for (const i of postings[term]) { state.gains[i] -= direction; if (++work % 1024 === 0) yield; }
      }
      if (++work % 1024 === 0) yield;
    }
  };
  const pathFor = (row: Candidate, state: State) => [...row.paths].sort((a, b) => b.cells.filter(c => !state.cells.has(c)).length - a.cells.filter(c => !state.cells.has(c)).length || b.knownDimensions - a.knownDimensions || compare('path', a.key, b.key))[0];
  const deviations = (state: State) => ({ length: tv(state.buckets, state.unique, bucketDistribution), task: tv(state.tasks, state.unique, taskDistribution) });
  const feasible = (state: State) => {
    const d = deviations(state);
    return state.picks.length === total && state.cost <= tokenBudget && (!distributionEnabled || (d.length <= lengthLimit(state.unique) + 1e-9 && d.task <= taskLimit(state.unique) + 1e-9)) && [...requiredTasks].every(t => state.tasks[t] > 0) && [...requiredCells].every(c => state.cells.has(c));
  };
  const fromPicks = function* (picks: Pick[]): Generator<void, State> {
    const state = fresh();
    for (const pick of picks) { state.picks.push(pick); yield* change(state, pick, 1); }
    return state;
  };
  const byLength = groups.map((_, i) => i).sort((a, b) => groups[a].cost - groups[b].cost || compare('cheap', groups[a].key, groups[b].key));
  const priorities = [0, 1, 2].map(variant => {
    const order = groups.map((_, i) => i).sort((a, b) => compare(`input-${variant}`, groups[a].key, groups[b].key));
    const priority = new Int32Array(groupCount); order.forEach((i, rank) => { priority[i] = rank; }); return priority;
  });
  const denominators = new Map([0, .5, 1].map(power => [power, Float64Array.from(groups, g => Math.max(1, g.cost) ** power)]));
  const construct = function* (power: number, variant: number, representative: boolean, price = 0, initial = forced): Generator<void, State | undefined> {
    const state = yield* fromPicks(initial);
    const targetUnique = Math.min(groupCount, state.unique + total - state.picks.length);
    const priority = priorities[variant], denominator = denominators.get(power)!;
    while (state.picks.length < total && state.unique < groupCount) {
      const needed = Math.min(groupCount - state.unique - 1, total - state.picks.length - 1);
      const cheap = new Set<number>(); let sum = 0, nextCost = 0;
      for (const i of byLength) {
        if (++work % 256 === 0) yield;
        if (state.groups[i]) continue;
        if (cheap.size < needed) { cheap.add(i); sum += groups[i].cost; } else { nextCost = groups[i].cost; break; }
      }
      const excess = (counts: number[], distribution: number[]) => counts.map((_, index) => counts.reduce((n, count, b) => n + Math.max(0, (count + Number(b === index)) / targetUnique - distribution[b]), 0));
      const bucketAllowed = excess(state.buckets, bucketDistribution).map(v => !distributionEnabled || v <= lengthLimit(targetUnique) + 1e-9);
      const taskAllowed = excess(state.tasks, taskDistribution).map(v => !distributionEnabled || v <= taskLimit(targetUnique) + 1e-9);
      const bucketDeviation = state.buckets.map((v, b) => Math.max(0, (v + 1) / targetUnique - bucketDistribution[b]));
      const taskDeviation = state.tasks.map((v, t) => Math.max(0, (v + 1) / targetUnique - taskDistribution[t]));
      let best = -1, bestScore = -Infinity, bestDeviation = Infinity;
      for (let i = 0; i < groupCount; i++) {
        if (++work % 256 === 0) yield;
        if (state.groups[i]) continue;
        const g = groups[i], reserve = sum + (cheap.has(i) ? nextCost - g.cost : 0);
        if (state.cost + g.cost + reserve > tokenBudget) continue;
        if (!bucketAllowed[g.bucket] || !taskAllowed[g.task]) continue;
        const deviation = bucketDeviation[g.bucket] + taskDeviation[g.task];
        const score = state.gains[i] / denominator[i] - price * g.cost;
        const better = representative && deviation !== bestDeviation ? deviation < bestDeviation : score > bestScore || (score === bestScore && (best < 0 || priority[i] < priority[best]));
        if (better) { best = i; bestScore = score; bestDeviation = deviation; }
      }
      if (best < 0) return undefined;
      const row = groups[best].rows[0], pick = { row, group: best, path: pathFor(row, state), reason: 'budget_coverage' };
      state.picks.push(pick); yield* change(state, pick, 1);
    }
    while (state.picks.length < total) {
      const selected = new Set(state.picks.map(p => p.row.key));
      const available = groups.map((g, i) => ({ g, i, row: g.rows.find(r => !selected.has(r.key)) })).filter(g => g.row)
        .sort((a, b) => state.groups[a.i] - state.groups[b.i] || compare('refill', a.g.key, b.g.key))[0];
      if (!available) throw new Error('SOURCE_CORRUPT');
      const pick = { row: available.row!, group: available.i, path: pathFor(available.row!, state), reason: 'variant_return' };
      state.picks.push(pick); yield* change(state, pick, 1);
    }
    return state;
  };
  const replacement = (state: State, outgoing: Pick[], incoming: Pick[]) => {
    const buckets = [...state.buckets], tasks = [...state.tasks], changedGroups = new Map<number, number>(), changedCells = new Map<string, number>();
    let cost = state.cost, unique = state.unique;
    for (const [list, d] of [[outgoing, -1], [incoming, 1]] as const) for (const pick of list) {
      const g = groups[pick.group]; cost += d * g.cost;
      changedGroups.set(pick.group, (changedGroups.get(pick.group) || 0) + d);
      for (const cell of new Set(pick.path.cells)) changedCells.set(cell, (changedCells.get(cell) || 0) + d);
    }
    if (cost > tokenBudget) return false;
    for (const [i, d] of changedGroups) {
      const delta = Number(state.groups[i] + d > 0) - Number(state.groups[i] > 0);
      unique += delta; buckets[groups[i].bucket] += delta; tasks[groups[i].task] += delta;
    }
    if ([...requiredTasks].some(t => !tasks[t]) || [...requiredCells].some(c => (state.cells.get(c) || 0) + (changedCells.get(c) || 0) <= 0)) return false;
    return !distributionEnabled || (tv(buckets, unique, bucketDistribution) <= lengthLimit(unique) + 1e-9 && tv(tasks, unique, taskDistribution) <= taskLimit(unique) + 1e-9);
  };
  const termDelta = new Int8Array(vocabularySize), touched: number[] = [];
  const coverageDelta = function* (state: State, outgoing: Pick[], incoming: Pick[]): Generator<void, number> {
    touched.length = 0;
    let gain = 0;
    for (const p of outgoing) for (const term of groups[p.group].terms) {
      if (termDelta[term] === 0) touched.push(term);
      termDelta[term]--; if (++work % 1024 === 0) yield;
    }
    for (const term of touched) gain -= Number(state.refs[term] + termDelta[term] === 0);
    for (const p of incoming) for (const term of groups[p.group].terms) {
      if (state.refs[term] + termDelta[term] === 0) gain++;
      termDelta[term]++; if (++work % 1024 === 0) yield;
    }
    for (const p of incoming) for (const term of groups[p.group].terms) termDelta[term] = 0;
    for (const term of touched) termDelta[term] = 0;
    return gain;
  };
  const applySwap = function* (state: State, outgoing: Pick[], incoming: Pick[]): Generator<void, void> {
    const removed = new Set(outgoing.map(p => p.row.key));
    state.picks = state.picks.filter(p => !removed.has(p.row.key));
    for (const pick of outgoing) yield* change(state, pick, -1);
    for (const pick of incoming) { state.picks.push(pick); yield* change(state, pick, 1); }
  };
  let repairSwaps = 0, repairAttempts = 0;
  const violation = (cost: number, unique: number, buckets: number[], tasks: number[]) => Math.max(0, cost - tokenBudget) / Math.max(1, baseTokens)
    + (distributionEnabled ? Math.max(0, tv(buckets, unique, bucketDistribution) - lengthLimit(unique)) + Math.max(0, tv(tasks, unique, taskDistribution) - taskLimit(unique)) : 0);
  const repair = function* (state: State): Generator<void, State> {
    if (experiment.repair === false || feasible(state)) return state;
    repairAttempts++;
    for (let pass = 0; pass < Math.min(total, 32); pass++) {
      const current = violation(state.cost, state.unique, state.buckets, state.tasks);
      if (current <= 1e-9) break;
      const alternatives = new Set<number>(), cells = new Map<string, number>();
      for (const i of byLength) {
        if (++work % 256 === 0) yield;
        if (state.groups[i]) continue;
        const g = groups[i], key = `${g.bucket}:${g.task}`, count = cells.get(key) || 0;
        if (count < 3) { alternatives.add(i); cells.set(key, count + 1); }
      }
      let best: { outgoing: Pick; incoming: Pick; penalty: number; gain: number; cost: number } | undefined;
      for (const i of alternatives) {
        const g = groups[i], incoming: Pick = { row: g.rows[0], group: i, path: pathFor(g.rows[0], state), reason: 'constraint_repair' };
        for (const outgoing of state.picks) {
          if (++work % 256 === 0) yield;
          const old = groups[outgoing.group], remove = Number(state.groups[outgoing.group] === 1), unique = state.unique + 1 - remove;
          const buckets = [...state.buckets], tasks = [...state.tasks];
          buckets[old.bucket] -= remove; buckets[g.bucket]++; tasks[old.task] -= remove; tasks[g.task]++;
          if ([...requiredTasks].some(t => !tasks[t])) continue;
          if ([...requiredCells].some(c => (state.cells.get(c) || 0) - Number(outgoing.path.cells.includes(c)) + Number(incoming.path.cells.includes(c)) <= 0)) continue;
          const cost = state.cost - old.cost + g.cost, penalty = violation(cost, unique, buckets, tasks);
          if (penalty >= current - 1e-9 || (best && penalty > best.penalty + 1e-9)) continue;
          const gain = yield* coverageDelta(state, [outgoing], [incoming]);
          if (!best || penalty < best.penalty - 1e-9 || gain > best.gain || (gain === best.gain && cost < best.cost)) best = { outgoing, incoming, penalty, gain, cost };
        }
      }
      if (!best) break;
      yield* applySwap(state, [best.outgoing], [best.incoming]); repairSwaps++;
    }
    return state;
  };
  const improve = function* (state: State): Generator<void, State> {
    if (experiment.swaps === false || !feasible(state)) return state;
    let removal: { p: Pick; loss: number }[] | undefined;
    for (let pass = 0; pass < 2; pass++) {
      const incoming = groups.map((g, i) => ({ g, i })).filter(({ i }) => !state.groups[i])
        .sort((a, b) => state.gains[b.i] - state.gains[a.i] || a.g.cost - b.g.cost || compare('swap-in', a.g.key, b.g.key)).slice(0, 64);
      let improved = false;
      for (const { g, i } of incoming) {
        if (state.groups[i] || state.gains[i] === 0) continue;
        const pick: Pick = { row: g.rows[0], group: i, path: pathFor(g.rows[0], state), reason: 'coverage_swap' };
        if (!removal) {
          removal = [];
          for (const p of state.picks) {
            let loss = 0;
            for (const term of groups[p.group].terms) { if (state.refs[term] === 1) loss++; if (++work % 1024 === 0) yield; }
            removal.push({ p, loss });
          }
          removal.sort((a, b) => a.loss - b.loss || groups[b.p.group].cost - groups[a.p.group].cost || compare('swap-out', a.p.row.key, b.p.row.key));
        }
        let best: Pick | undefined, gain = 0;
        for (const { p } of removal.slice(0, 32)) {
          if (!replacement(state, [p], [pick])) continue;
          const value = yield* coverageDelta(state, [p], [pick]);
          if (value > gain) { gain = value; best = p; }
        }
        if (best) { yield* applySwap(state, [best], [pick]); state.oneSwaps++; improved = true; removal = undefined; }
      }
      if (!improved && experiment.pairSwaps !== false) {
        const ins = groups.map((g, i) => ({ g, i })).filter(({ i }) => !state.groups[i]).sort((a, b) => state.gains[b.i] - state.gains[a.i] || compare('pair-in', a.g.key, b.g.key)).slice(0, 8)
          .map(({ g, i }) => ({ row: g.rows[0], group: i, path: pathFor(g.rows[0], state), reason: 'coverage_pair_swap' }));
        const losses: { p: Pick; loss: number }[] = [];
        for (const p of state.picks) { let loss = 0; for (const term of groups[p.group].terms) { if (state.refs[term] === 1) loss++; if (++work % 1024 === 0) yield; } losses.push({ p, loss }); }
        const outs = losses.sort((a, b) => a.loss - b.loss || compare('pair-out', a.p.row.key, b.p.row.key)).slice(0, 8).map(r => r.p);
        let best: { outgoing: Pick[]; incoming: Pick[] } | undefined, gain = 0;
        for (let a = 0; a < ins.length; a++) for (let b = a + 1; b < ins.length; b++) for (let c = 0; c < outs.length; c++) for (let d = c + 1; d < outs.length; d++) {
          if (++work % 256 === 0) yield;
          if (state.gains[ins[a].group] + state.gains[ins[b].group] === 0) continue;
          const outgoing = [outs[c], outs[d]], incoming = [ins[a], ins[b]];
          if (!replacement(state, outgoing, incoming)) continue;
          const value = yield* coverageDelta(state, outgoing, incoming);
          if (value > gain) { gain = value; best = { outgoing, incoming }; }
        }
        if (best) { yield* applySwap(state, best.outgoing, best.incoming); state.pairSwaps++; improved = true; removal = undefined; }
      }
      if (!improved) break;
    }
    return state;
  };
  let efficiencySwaps = 0, bridgeAttempts = 0, bridgeAccepted = 0;
  const improveEfficiency = function* (state: State): Generator<void, State> {
    if (experiment.swaps === false || experiment.efficiencySwaps === false || (experiment.upperBound !== false && state.vocabulary === coverageUpperBound)) return state;
    const inputRank = priorities[0];
    let removal: { pick: Pick; loss: number }[] | undefined;
    for (let pass = 0; pass < 2; pass++) {
      const available = groups.map((g, i) => ({ g, i })).filter(({ i }) => !state.groups[i]);
      const incoming = [...available].sort((a, b) => state.gains[b.i] / Math.max(1, b.g.cost) - state.gains[a.i] / Math.max(1, a.g.cost) || inputRank[a.i] - inputRank[b.i]).slice(0, 32);
      const byGain = available.sort((a, b) => state.gains[b.i] - state.gains[a.i] || inputRank[a.i] - inputRank[b.i]).slice(0, 16);
      for (const item of byGain) if (!incoming.some(p => p.i === item.i)) incoming.push(item);
      let improved = false;
      for (const { g, i } of incoming) {
        if (state.groups[i] || state.gains[i] === 0) continue;
        const pick: Pick = { row: g.rows[0], group: i, path: pathFor(g.rows[0], state), reason: 'efficiency_swap' };
        if (!removal) {
          const losses: { pick: Pick; loss: number }[] = [];
          for (const p of state.picks) {
            let loss = 0;
            for (const term of groups[p.group].terms) { if (state.refs[term] === 1) loss++; if (++work % 1024 === 0) yield; }
            losses.push({ pick: p, loss });
          }
          removal = [...losses].sort((a, b) => a.loss - b.loss || compare('swap-out', a.pick.row.key, b.pick.row.key)).slice(0, 32);
          for (const item of losses.sort((a, b) => groups[b.pick.group].cost - groups[a.pick.group].cost || a.loss - b.loss || compare('swap-out', a.pick.row.key, b.pick.row.key)).slice(0, 32)) if (!removal.includes(item)) removal.push(item);
        }
        let best: Pick | undefined, bestGain = 0;
        for (const { pick: outgoing } of removal) {
          if (!replacement(state, [outgoing], [pick])) continue;
          const gain = yield* coverageDelta(state, [outgoing], [pick]);
          if (gain > bestGain) { bestGain = gain; best = outgoing; }
        }
        if (best) { yield* applySwap(state, [best], [pick]); efficiencySwaps++; improved = true; removal = undefined; }
      }
      if (!improved) break;
    }
    return state;
  };
  const bridge = function* (state: State): Generator<void, void> {
    if (experiment.budgetBridge === false || experiment.swaps === false || state.vocabulary === coverageUpperBound) return;
    const original = [...state.picks], originalVocabulary = state.vocabulary;
    const originalEfficiency = efficiencySwaps;
    const incoming = groups.map((g, i) => ({ g, i })).filter(({ i }) => !state.groups[i])
      .sort((a, b) => state.gains[b.i] / Math.max(1, b.g.cost) - state.gains[a.i] / Math.max(1, a.g.cost) || priorities[0][a.i] - priorities[0][b.i]).slice(0, 48);
    const outgoing = [...state.picks].sort((a, b) => groups[b.group].cost - groups[a.group].cost || compare('bridge-out', a.row.key, b.row.key)).slice(0, 32);
    const proposals: { out: Pick; incoming: Pick; loss: number; saving: number }[] = [];
    for (const { g, i } of incoming) for (const out of outgoing) {
      if (++work % 256 === 0) yield;
      const saving = groups[out.group].cost - g.cost;
      if (saving <= 0) continue;
      const pick: Pick = { row: g.rows[0], group: i, path: pathFor(g.rows[0], state), reason: 'budget_bridge' };
      if (!replacement(state, [out], [pick])) continue;
      const gain = yield* coverageDelta(state, [out], [pick]);
      proposals.push({ out, incoming: pick, loss: Math.max(0, -gain), saving });
    }
    proposals.sort((a, b) => b.saving / (1 + b.loss) - a.saving / (1 + a.loss) || a.loss - b.loss || compare('bridge-in', a.incoming.row.key, b.incoming.row.key));
    for (const proposal of proposals.slice(0, 4)) {
      bridgeAttempts++;
      yield* applySwap(state, [proposal.out], [proposal.incoming]);
      yield* improveEfficiency(state);
      if (state.vocabulary > originalVocabulary && feasible(state)) { bridgeAccepted++; return; }
      const prior = new Map(original.map(p => [p.row.key, p.path.key])), current = new Map(state.picks.map(p => [p.row.key, p.path.key]));
      yield* applySwap(state, state.picks.filter(p => prior.get(p.row.key) !== p.path.key), original.filter(p => current.get(p.row.key) !== p.path.key));
      state.picks = [...original];
      efficiencySwaps = originalEfficiency;
    }
  };
  const base = yield* fromPicks(baselinePicks);
  let best: State | undefined, evaluated = 0, feasibleCount = 0;
  const visited = new Set<string>();
  const consider = function* (state: State | undefined): Generator<void, void> {
    evaluated++;
    if (state && experiment.repair !== false) yield* repair(state);
    if (!state || !feasible(state)) return;
    feasibleCount++;
    const identity = hash(state.picks.map(p => [p.row.key, p.path.key]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    if (visited.has(identity)) return;
    visited.add(identity);
    if (experiment.upperBound === false || state.vocabulary < coverageUpperBound) yield* improve(state);
    const d = deviations(state), old = best && deviations(best);
    if (!best || state.vocabulary > best.vocabulary || (state.vocabulary === best.vocabulary && (d.length + d.task < old!.length + old!.task || (d.length + d.task === old!.length + old!.task && state.cost < best.cost)))) best = state;
  };
  yield* consider(base);
  for (const power of experiment.restarts === false ? [0] : [0, .5, 1]) {
    for (const variant of experiment.restarts === false ? [0] : [0, 1]) {
      if (experiment.upperBound !== false && best?.vocabulary === coverageUpperBound) break;
      yield* consider(yield* construct(power, variant, false));
    }
  }
  if (experiment.restarts !== false && (experiment.upperBound === false || best?.vocabulary !== coverageUpperBound)) yield* consider(yield* construct(.5, 2, true));
  if (experiment.restarts !== false && experiment.pricedStarts !== false) {
    if (best) yield* improveEfficiency(best);
    for (const factor of [.25, .5, 1]) {
      if (experiment.upperBound !== false && best?.vocabulary === coverageUpperBound) break;
      yield* consider(yield* construct(0, 0, false, factor * base.vocabulary / Math.max(1, baseTokens)));
    }
  }
  if (best) { yield* improveEfficiency(best); yield* bridge(best); }
  let neighborhoodAttempts = 0, neighborhoodAccepted = 0;
  if (best && experiment.neighborhood !== false && experiment.swaps !== false) {
    let incumbent: State = best;
    for (let round = 0; round < 2; round++) {
      let accepted = false;
      for (const mode of [0, 1, 2]) {
        if (incumbent.vocabulary === coverageUpperBound) break;
        const partial: State = yield* fromPicks(incumbent.picks);
        const removable: { pick: Pick; loss: number }[] = [];
        for (const pick of partial.picks) {
          let loss = 0;
          for (const term of groups[pick.group].terms) { loss += Number(partial.refs[term] === 1); if (++work % 1024 === 0) yield; }
          removable.push({ pick, loss });
        }
        removable.sort((a, b) => (mode === 0 ? groups[b.pick.group].cost / (1 + b.loss) - groups[a.pick.group].cost / (1 + a.loss) : mode === 1 ? groups[b.pick.group].cost - groups[a.pick.group].cost : 0) || compare(`neighborhood-${round}`, a.pick.row.key, b.pick.row.key));
        let removed = 0;
        for (const { pick } of removable) {
          if (removed >= Math.min(32, Math.ceil(total * .2))) break;
          const g = groups[pick.group], last = partial.groups[pick.group] === 1;
          if (last && requiredTasks.has(g.task) && partial.tasks[g.task] <= 1) continue;
          if (pick.path.cells.some(c => requiredCells.has(c) && (partial.cells.get(c) || 0) <= 1)) continue;
          yield* applySwap(partial, [pick], []); removed++;
        }
        if (!removed) continue;
        for (const power of [0, .5, 1]) {
          neighborhoodAttempts++;
          const state: State | undefined = yield* construct(power, round, false, 0, partial.picks);
          if (!state) continue;
          yield* repair(state);
          if (!feasible(state)) continue;
          yield* improveEfficiency(state);
          if (state.vocabulary > incumbent.vocabulary) { incumbent = state; neighborhoodAccepted++; accepted = true; }
        }
      }
      if (!accepted) break;
    }
    best = incumbent;
  }
  let completePasses = 0, completeSwaps = 0, plateauSwaps = 0;
  let completeStopped = experiment.completeExchange === false || experiment.swaps === false ? 'disabled' : 'no_feasible_start';
  if (best && experiment.completeExchange !== false && experiment.swaps !== false) {
    const state: State = best;
    const owners = new Int32Array(vocabularySize), recovered = new Int32Array(total), losses = new Int32Array(total);
    completeStopped = 'pass_limit';
    for (let pass = 0; pass < Math.min(64, total); pass++) {
      if (state.vocabulary === coverageUpperBound && costSaturated(state.cost)) { completeStopped = 'coverage_and_cost_bound'; break; }
      completePasses++;
      const outgoing = [...state.picks].sort((a, b) => a.row.key.localeCompare(b.row.key));
      owners.fill(-1); losses.fill(0);
      for (let j = 0; j < outgoing.length; j++) for (const term of groups[outgoing[j].group].terms) {
        if (state.refs[term] === 1) { owners[term] = j; losses[j]++; }
        if (++work % 1024 === 0) yield;
      }
      let proposal: { incoming: Pick; outgoing: Pick; gain: number; saving: number } | undefined;
      for (let i = 0; i < groupCount; i++) {
        if (state.groups[i]) continue;
        const g = groups[i]; recovered.fill(0);
        for (const term of g.terms) {
          if (owners[term] >= 0) recovered[owners[term]]++;
          if (++work % 1024 === 0) yield;
        }
        const row = g.rows[0], incoming: Pick = { row, group: i, path: pathFor(row, state), reason: 'complete_exchange' };
        for (let j = 0; j < outgoing.length; j++) {
          if (++work % 256 === 0) yield;
          const gain = state.gains[i] - losses[j] + recovered[j], saving = groups[outgoing[j].group].cost - g.cost;
          if (gain < 0 || (gain === 0 && (experiment.plateau === false || saving <= 0))) continue;
          if (proposal && (gain < proposal.gain || (gain === proposal.gain && saving <= proposal.saving))) continue;
          if (!replacement(state, [outgoing[j]], [incoming])) continue;
          proposal = { incoming, outgoing: outgoing[j], gain, saving };
        }
      }
      if (!proposal) { completeStopped = 'one_swap_local_optimum'; break; }
      yield* applySwap(state, [proposal.outgoing], [proposal.incoming]);
      completeSwaps++; if (proposal.gain === 0) plateauSwaps++;
    }
  }
  const fallback = !best;
  if (!best) {
    const legacy = yield* sampleSteps(candidates, limit, { ...policy, version: LEGACY_POLICY.version });
    best = yield* fromPicks(legacy.selected.map(resolve));
  }
  const d = deviations(best);
  return {
    selected: best.picks.map(p => ({ key: p.row.key, path: p.path, reason: p.reason })),
    counts: { candidates: candidates.length, inputs: groupCount, generated: best.picks.length, behaviorReserve: baseline.counts.behaviorReserve, behaviorReserveUsed: best.picks.filter(p => p.reason === 'behavior').length, coveredCells: best.cells.size },
    optimization: { requestedPolicy: policy.version, effectivePolicy: fallback ? LEGACY_POLICY.version : policy.version, fallbackReason: fallback ? 'NO_FEASIBLE_CONSTRUCTION' : null, feasible: !fallback && feasible(best), tokenBudget, baseTokens, tokens: best.cost, vocabulary: best.vocabulary, lengthTV: d.length, taskTV: d.task, lengthLimit: lengthLimit(best.unique), taskLimit: taskLimit(best.unique), distributionEnabled, evaluated, feasibleCount, oneSwaps: best.oneSwaps, pairSwaps: best.pairSwaps, repairSwaps, repairAttempts, efficiencySwaps, bridgeAttempts, bridgeAccepted, coverageUpperBound, coverageGap: coverageUpperBound - best.vocabulary, neighborhoodAttempts, neighborhoodAccepted, completePasses, completeSwaps, plateauSwaps, completeStopped, searchIndexBuilt: true },
  };
}

export function completeSample(candidates: Candidate[], limit: number, policy: Policy = COMPLETE_POLICY, experiment: CompleteExperiment = {}) {
  const steps = completeSampleSteps(candidates, limit, policy, experiment);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}
