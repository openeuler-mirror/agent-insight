import { hash, lexicalSteps, normalizeText, type Candidate, type Policy, type Selection } from './index';
import { FAST_POLICY, fastSampleSteps, type FastExperiment } from './budgeted-fast';

export const CONSENSUS_POLICY = Object.freeze({ ...FAST_POLICY, version: 'trace-coverage-v6.6' });
export type AgreementFeatures = { scores: Map<string, number>; groups: Map<string, Candidate[]>; groupScores: Map<string, number>; comparisons: number };

export function* agreementFeaturesSteps(candidates: Candidate[], answers: ReadonlyMap<string, string>): Generator<void, AgreementFeatures> {
  if (answers.size !== candidates.length || new Set(candidates.map(c => c.key)).size !== candidates.length) throw new Error('SOURCE_CORRUPT');
  const groups = new Map<string, Candidate[]>(), scores = new Map<string, number>(), groupScores = new Map<string, number>();
  let work = 0, comparisons = 0;
  for (const row of candidates) {
    if (typeof answers.get(row.key) !== 'string' || !answers.get(row.key)!.trim()) throw new Error('SOURCE_CORRUPT');
    const list = groups.get(row.inputKey) || []; list.push(row); groups.set(row.inputKey, list);
    if (++work % 256 === 0) yield;
  }
  for (const [inputKey, rows] of groups) {
    const distinct = new Map<string, { keys: string[]; terms: Set<string> }>();
    for (const row of [...rows].sort((a, b) => a.key.localeCompare(b.key))) {
      const text = normalizeText(answers.get(row.key)!), id = hash([text]);
      const old = distinct.get(id);
      if (old) old.keys.push(row.key);
      else { const feature = yield* lexicalSteps(text); distinct.set(id, { keys: [row.key], terms: new Set(feature.terms) }); }
    }
    const variants = [...distinct.values()], values: number[] = [];
    for (const answer of variants) {
      let sum = 0, support = 0;
      for (const peer of variants) {
        if (peer === answer) continue;
        let intersection = 0;
        const [small, large] = answer.terms.size <= peer.terms.size ? [answer.terms, peer.terms] : [peer.terms, answer.terms];
        for (const term of small) { intersection += Number(large.has(term)); if (++work % 1024 === 0) yield; }
        const union = answer.terms.size + peer.terms.size - intersection;
        sum += union ? intersection / union : 0; comparisons++;
        if (++support === 32) break;
      }
      const score = support ? sum / support : 0;
      values.push(score); for (const key of answer.keys) scores.set(key, score);
    }
    groupScores.set(inputKey, values.reduce((a, b) => a + b, 0) / values.length);
    if (++work % 64 === 0) yield;
  }
  return { scores, groups, groupScores, comparisons };
}

export function* consensusReplaceSteps(candidates: Candidate[], selected: Selection[], features: AgreementFeatures): Generator<void, { selected: Selection[]; replacements: number }> {
  const byKey = new Map(candidates.map(c => [c.key, c])), used = new Set(selected.map(s => s.key));
  const result: Selection[] = [];
  let replacements = 0, work = 0;
  for (const pick of selected) {
    const old = byKey.get(pick.key)!;
    let best = pick, score = features.scores.get(pick.key)!;
    for (const row of [...features.groups.get(old.inputKey)!].sort((a, b) => a.key.localeCompare(b.key))) {
      if (used.has(row.key) || features.scores.get(row.key)! <= score) continue;
      const path = [...row.paths].sort((a, b) => a.key.localeCompare(b.key)).find(p => pick.path.cells.every(c => p.cells.includes(c)));
      if (path) { best = { key: row.key, path, reason: 'answer_consensus' }; score = features.scores.get(row.key)!; }
      if (++work % 256 === 0) yield;
    }
    if (best !== pick) { used.delete(pick.key); used.add(best.key); replacements++; }
    result.push(best);
    if (++work % 256 === 0) yield;
  }
  return { selected: result, replacements };
}

export function* consensusSampleSteps(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = CONSENSUS_POLICY, experiment: FastExperiment = {}) {
  if (policy.version !== CONSENSUS_POLICY.version) throw new Error('INVALID_CONFIG');
  const baseline = yield* fastSampleSteps(candidates, limit, { ...policy, version: FAST_POLICY.version }, experiment);
  if (!baseline.optimization.feasible) return { ...baseline, optimization: { ...baseline.optimization, requestedPolicy: policy.version }, agreement: { replacements: 0, comparisons: 0, fallbackUnchanged: true } };
  const features = yield* agreementFeaturesSteps(candidates, answers);
  const changed = yield* consensusReplaceSteps(candidates, baseline.selected, features);
  return { ...baseline, selected: changed.selected, counts: { ...baseline.counts, behaviorReserveUsed: changed.selected.filter(s => s.reason === 'behavior').length, coveredCells: new Set(changed.selected.flatMap(s => s.path.cells)).size }, optimization: { ...baseline.optimization, requestedPolicy: policy.version, effectivePolicy: policy.version }, agreement: { replacements: changed.replacements, comparisons: features.comparisons, fallbackUnchanged: false } };
}

export function consensusSample(candidates: Candidate[], answers: ReadonlyMap<string, string>, limit: number, policy: Policy = CONSENSUS_POLICY, experiment: FastExperiment = {}) {
  const steps = consensusSampleSteps(candidates, answers, limit, policy, experiment);
  let next = steps.next(); while (!next.done) next = steps.next(); return next.value;
}
