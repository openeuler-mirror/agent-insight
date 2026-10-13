import { hash, lexicalSteps, normalizeText, type Candidate } from './index';
import { type AgreementFeatures } from './answer-consensus';
import { type SharedAnswers } from './answer-shared';

export function* directAnswerFeaturesSteps(candidates: Candidate[], answers: ReadonlyMap<string, string>, beta: 2 | 4 = 2): Generator<void, AgreementFeatures> {
  if (answers.size !== candidates.length || new Set(candidates.map(c => c.key)).size !== candidates.length || ![2, 4].includes(beta)) throw new Error('SOURCE_CORRUPT');
  const groups = new Map<string, Candidate[]>(), records: SharedAnswers['records'] = new Map();
  let work = 0;
  for (const row of candidates) {
    if (typeof answers.get(row.key) !== 'string' || !answers.get(row.key)!.trim()) throw new Error('SOURCE_CORRUPT');
    const rows = groups.get(row.inputKey) || []; rows.push(row); groups.set(row.inputKey, rows);
    if (++work % 256 === 0) yield;
  }
  for (const [key, rows] of groups) {
    const distinct = new Map<string, { keys: string[]; text: string }>();
    for (const row of [...rows].sort((a, b) => a.key.localeCompare(b.key))) {
      const text = normalizeText(answers.get(row.key)!), id = hash([text]), old = distinct.get(id);
      if (old) old.keys.push(row.key); else distinct.set(id, { keys: [row.key], text });
      if (++work % 64 === 0) yield;
    }
    records.set(key, [...distinct.values()]);
  }
  const agreement = { groups, scores: new Map<string, number>(), groupScores: new Map<string, number>(), comparisons: 0 };
  return yield* directWeightedSteps({ records, agreement, recall: agreement }, beta);
}

export function* directWeightedSteps(shared: SharedAnswers, beta: 2 | 4): Generator<void, AgreementFeatures> {
  const frequencies = new Map<string, number>(), scores = new Map<string, number>(), groupScores = new Map<string, number>();
  let work = 0, comparisons = 0;
  for (const variants of shared.records.values()) {
    const union = new Set<string>();
    for (const answer of variants) {
      if (!answer.terms) answer.terms = new Set((yield* lexicalSteps(answer.text)).terms);
      for (const term of answer.terms) { union.add(term); if (++work % 1024 === 0) yield; }
    }
    for (const term of union) { frequencies.set(term, (frequencies.get(term) || 0) + 1); if (++work % 1024 === 0) yield; }
  }
  const weights = new Map<string, number>();
  for (const [term, count] of frequencies) { weights.set(term, 1 + Math.log((shared.records.size + 1) / (count + 1))); if (++work % 1024 === 0) yield; }
  for (const [inputKey, variants] of shared.records) {
    const masses: number[] = [], values: number[] = [];
    for (const answer of variants) {
      let mass = 0; for (const term of answer.terms!) { mass += weights.get(term)!; if (++work % 1024 === 0) yield; } masses.push(mass);
    }
    for (let i = 0; i < variants.length; i++) {
      const answer = variants[i]; let sum = 0, support = 0;
      for (let j = 0; j < variants.length; j++) {
        if (i === j) continue;
        const peer = variants[j]; let intersection = 0;
        const [small, large] = answer.terms!.size <= peer.terms!.size ? [answer.terms!, peer.terms!] : [peer.terms!, answer.terms!];
        for (const term of small) { if (large.has(term)) intersection += weights.get(term)!; if (++work % 1024 === 0) yield; }
        const square = beta * beta, denominator = square * masses[j] + masses[i]; sum += denominator ? (1 + square) * intersection / denominator : 0; comparisons++;
        if (++support === 32) break;
      }
      const score = support ? sum / support : 0; values.push(score);
      for (const key of answer.keys) scores.set(key, score);
    }
    groupScores.set(inputKey, values.reduce((a, b) => a + b, 0) / values.length);
    if (++work % 64 === 0) yield;
  }
  return { groups: shared.agreement.groups, scores, groupScores, comparisons };
}

