import { COVERAGE_POLICY, LEGACY_POLICY, hash, lengthBucket, sampleSteps, type Candidate, type Path, type Policy, type Selection } from './index';

export const BUDGETED_POLICY = Object.freeze({ ...COVERAGE_POLICY, version: 'trace-coverage-v6' });
export type BudgetedExperiment = { budgetRatio?: number; swaps?: boolean; pairSwaps?: boolean; restarts?: boolean; distribution?: boolean };
type Group = { key: string; rows: Candidate[]; terms: number[]; cost: number; bucket: number; task: number };
type Pick = { row: Candidate; group: number; path: Path; reason: string };
type State = { picks: Pick[]; groups: Int32Array; refs: Int32Array; gains: Int32Array; buckets: number[]; tasks: number[]; cells: Map<string, number>; cost: number; vocabulary: number; unique: number; oneSwaps: number; pairSwaps: number };
const tv = (counts: number[], size: number, distribution: number[]) => counts.reduce((sum, n, i) => sum + Math.abs((size ? n / size : 0) - distribution[i]), 0) / 2;

export function* budgetedSampleSteps(candidates: Candidate[], limit: number, policy: Policy = BUDGETED_POLICY, experiment: BudgetedExperiment = {}) {
  const ratio = experiment.budgetRatio ?? 1.1;
  if (!candidates.length) throw new Error('NO_VALID_SAMPLES');
  if (policy.version !== BUDGETED_POLICY.version || !Number.isInteger(policy.seed) || !Number.isFinite(policy.rho) || policy.rho < 0 || policy.rho > 1 || !Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isFinite(ratio) || ratio < 1 || ratio > 1.2) throw new Error('INVALID_CONFIG');
  const total = Math.min(limit, candidates.length), byKey = new Map<string, number>();
  const grouped = new Map<string, Candidate[]>(), vocabulary = new Map<string, number>();
  const taskNames = [...new Set(candidates.map(c => c.task))].sort();
  const groups: Group[] = [], postings: number[][] = [];
  const rankCache = new Map<string, string>();
  const rank = (phase: string, key: string) => {
    const id = `${phase}:${key}`;
    let value = rankCache.get(id);
    if (!value) { value = hash([policy.version, policy.seed, phase, key]); rankCache.set(id, value); }
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
  if (!taskNames.includes('unknown')) taskNames.push('unknown');
  const poolBuckets = [0, 0, 0, 0], poolTasks = taskNames.map(() => 0);
  for (const key of [...grouped.keys()].sort()) {
    const rows = grouped.get(key)!.sort((a, b) => compare('answer', a.key, b.key));
    const feature = rows[0].lexical!, terms: number[] = [];
    const uniqueTerms = [...new Set(feature.terms)].sort();
    for (const row of rows) {
      if (row.lexical!.tokenCount !== feature.tokenCount || row.lexical!.terms.length !== feature.terms.length || [...new Set(row.lexical!.terms)].sort().some((term, i) => term !== uniqueTerms[i])) throw new Error('SOURCE_CORRUPT');
      byKey.set(row.key, groups.length);
    }
    for (const term of uniqueTerms) {
      if (++work % 1024 === 0) yield;
      let id = vocabulary.get(term);
      if (id === undefined) { id = vocabulary.size; vocabulary.set(term, id); postings.push([]); }
      terms.push(id); postings[id].push(groups.length);
    }
    const tasks = [...new Set(rows.map(c => c.task).filter(t => t !== 'unknown'))];
    const task = taskNames.indexOf(tasks.length === 1 ? tasks[0] : 'unknown'), bucket = lengthBucket(feature.tokenCount);
    groups.push({ key, rows, terms, cost: feature.tokenCount, bucket, task }); poolBuckets[bucket]++; poolTasks[task]++;
  }
  const groupCount = groups.length, baseTokens = total * groups.reduce((n, g) => n + g.cost, 0) / groupCount;
  const tokenBudget = Math.floor(baseTokens * ratio + 1e-9);
  const bucketDistribution = poolBuckets.map(n => n / groupCount), taskDistribution = poolTasks.map(n => n / groupCount);
  const baseline = yield* sampleSteps(candidates, limit, { ...policy, version: COVERAGE_POLICY.version });
  const resolve = (s: Selection): Pick => ({ row: candidates.find(c => c.key === s.key)!, group: byKey.get(s.key)!, path: s.path, reason: s.reason });
  const baselinePicks = baseline.selected.map(resolve);
  const forced = baselinePicks.filter(p => p.reason === 'task_floor' || p.reason === 'behavior');
  const requiredTasks = new Set(forced.filter(p => p.reason === 'task_floor').map(p => groups[p.group].task));
  const requiredCells = new Set(forced.flatMap(p => p.path.cells));
  const distributionEnabled = experiment.distribution !== false;
  const lengthLimit = (q: number) => Math.max(.10, 2 / Math.max(1, q));
  const taskLimit = (q: number) => Math.max(.20, 2 / Math.max(1, q));
  const fresh = (): State => ({ picks: [], groups: new Int32Array(groupCount), refs: new Int32Array(vocabulary.size), gains: Int32Array.from(groups, g => g.terms.length), buckets: [0, 0, 0, 0], tasks: poolTasks.map(() => 0), cells: new Map(), cost: 0, vocabulary: 0, unique: 0, oneSwaps: 0, pairSwaps: 0 });
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
  const construct = function* (power: number, variant: number, representative: boolean): Generator<void, State | undefined> {
    const state = yield* fromPicks(forced);
    const targetUnique = Math.min(groupCount, state.unique + total - state.picks.length);
    while (state.picks.length < total && state.unique < groupCount) {
      const needed = Math.min(groupCount - state.unique - 1, total - state.picks.length - 1);
      const cheap = new Set<number>(); let sum = 0, nextCost = 0;
      for (const i of byLength) {
        if (++work % 256 === 0) yield;
        if (state.groups[i]) continue;
        if (cheap.size < needed) { cheap.add(i); sum += groups[i].cost; } else { nextCost = groups[i].cost; break; }
      }
      let best = -1, bestScore = -Infinity, bestDeviation = Infinity;
      for (let i = 0; i < groupCount; i++) {
        if (++work % 256 === 0) yield;
        if (state.groups[i]) continue;
        const g = groups[i], reserve = sum + (cheap.has(i) ? nextCost - g.cost : 0);
        if (state.cost + g.cost + reserve > tokenBudget) continue;
        const excess = (counts: number[], distribution: number[], index: number) => counts.reduce((n, count, b) => n + Math.max(0, (count + Number(b === index)) / targetUnique - distribution[b]), 0);
        if (distributionEnabled && (excess(state.buckets, bucketDistribution, g.bucket) > lengthLimit(targetUnique) + 1e-9 || excess(state.tasks, taskDistribution, g.task) > taskLimit(targetUnique) + 1e-9)) continue;
        const deviation = Math.max(0, (state.buckets[g.bucket] + 1) / targetUnique - bucketDistribution[g.bucket]) + Math.max(0, (state.tasks[g.task] + 1) / targetUnique - taskDistribution[g.task]);
        const score = state.gains[i] / Math.max(1, g.cost) ** power;
        const better = representative && deviation !== bestDeviation ? deviation < bestDeviation : score > bestScore || (score === bestScore && (best < 0 || compare(`input-${variant}`, g.key, groups[best].key) < 0));
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
  const coverageDelta = function* (state: State, outgoing: Pick[], incoming: Pick[]): Generator<void, number> {
    const delta = new Map<number, number>();
    for (const [list, direction] of [[outgoing, -1], [incoming, 1]] as const) for (const p of list) for (const term of groups[p.group].terms) {
      delta.set(term, (delta.get(term) || 0) + direction); if (++work % 1024 === 0) yield;
    }
    let gain = 0;
    for (const [term, d] of delta) { gain += Number(state.refs[term] + d > 0) - Number(state.refs[term] > 0); if (++work % 1024 === 0) yield; }
    return gain;
  };
  const applySwap = function* (state: State, outgoing: Pick[], incoming: Pick[]): Generator<void, void> {
    const removed = new Set(outgoing.map(p => p.row.key));
    state.picks = state.picks.filter(p => !removed.has(p.row.key));
    for (const pick of outgoing) yield* change(state, pick, -1);
    for (const pick of incoming) { state.picks.push(pick); yield* change(state, pick, 1); }
  };
  const improve = function* (state: State): Generator<void, State> {
    if (experiment.swaps === false || !feasible(state)) return state;
    let removal: { p: Pick; loss: number }[] | undefined;
    for (let pass = 0; pass < 2; pass++) {
      const incoming = groups.map((g, i) => ({ g, i })).filter(({ i }) => !state.groups[i])
        .sort((a, b) => state.gains[b.i] - state.gains[a.i] || a.g.cost - b.g.cost || compare('swap-in', a.g.key, b.g.key)).slice(0, 64);
      let improved = false;
      for (const { g, i } of incoming) {
        if (state.groups[i]) continue;
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
  const base = yield* fromPicks(baselinePicks);
  let best: State | undefined, evaluated = 0, feasibleCount = 0;
  const visited = new Set<string>();
  const consider = function* (state: State | undefined): Generator<void, void> {
    evaluated++;
    if (!state || !feasible(state)) return;
    feasibleCount++;
    const identity = hash(state.picks.map(p => [p.row.key, p.path.key, p.reason]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    if (visited.has(identity)) return;
    visited.add(identity);
    yield* improve(state);
    const d = deviations(state), old = best && deviations(best);
    if (!best || state.vocabulary > best.vocabulary || (state.vocabulary === best.vocabulary && (d.length + d.task < old!.length + old!.task || (d.length + d.task === old!.length + old!.task && state.cost < best.cost)))) best = state;
  };
  yield* consider(base);
  for (const power of experiment.restarts === false ? [0] : [0, .5, 1]) {
    for (const variant of experiment.restarts === false ? [0] : [0, 1]) yield* consider(yield* construct(power, variant, false));
  }
  if (experiment.restarts !== false) yield* consider(yield* construct(.5, 2, true));
  const fallback = !best;
  if (!best) {
    const legacy = yield* sampleSteps(candidates, limit, { ...policy, version: LEGACY_POLICY.version });
    best = yield* fromPicks(legacy.selected.map(resolve));
  }
  const d = deviations(best);
  return {
    selected: best.picks.map(p => ({ key: p.row.key, path: p.path, reason: p.reason })),
    counts: { candidates: candidates.length, inputs: groupCount, generated: best.picks.length, behaviorReserve: baseline.counts.behaviorReserve, behaviorReserveUsed: best.picks.filter(p => p.reason === 'behavior').length, coveredCells: best.cells.size },
    optimization: { requestedPolicy: policy.version, effectivePolicy: fallback ? LEGACY_POLICY.version : policy.version, fallbackReason: fallback ? 'NO_FEASIBLE_CONSTRUCTION' : null, feasible: !fallback && feasible(best), tokenBudget, baseTokens, tokens: best.cost, vocabulary: best.vocabulary, lengthTV: d.length, taskTV: d.task, lengthLimit: lengthLimit(best.unique), taskLimit: taskLimit(best.unique), distributionEnabled, evaluated, feasibleCount, oneSwaps: best.oneSwaps, pairSwaps: best.pairSwaps },
  };
}

export function budgetedSample(candidates: Candidate[], limit: number, policy: Policy = BUDGETED_POLICY, experiment: BudgetedExperiment = {}) {
  const steps = budgetedSampleSteps(candidates, limit, policy, experiment);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}
