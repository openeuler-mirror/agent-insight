import { hash, lexicalSteps, normalizeText, type Candidate } from './index';
import { type AgreementFeatures } from './answer-consensus';

export type SharedAnswer = { keys: string[]; text: string; terms?: Set<string> };
export type SharedAnswers = { agreement: AgreementFeatures; recall: AgreementFeatures; records: Map<string, SharedAnswer[]> };

export function* sharedAnswerFeaturesSteps(candidates: Candidate[], answers: ReadonlyMap<string, string>): Generator<void, SharedAnswers> {
  if (answers.size !== candidates.length || new Set(candidates.map(c => c.key)).size !== candidates.length) throw new Error('SOURCE_CORRUPT');
  const groups = new Map<string, Candidate[]>(), records = new Map<string, SharedAnswer[]>();
  const agreement: AgreementFeatures = { groups, scores: new Map(), groupScores: new Map(), comparisons: 0 };
  const recall: AgreementFeatures = { groups, scores: new Map(), groupScores: new Map(), comparisons: 0 };
  let work = 0;
  for (const row of candidates) {
    if (typeof answers.get(row.key) !== 'string' || !answers.get(row.key)!.trim()) throw new Error('SOURCE_CORRUPT');
    const list = groups.get(row.inputKey) || []; list.push(row); groups.set(row.inputKey, list);
    if (++work % 256 === 0) yield;
  }
  for (const [inputKey, rows] of groups) {
    const distinct = new Map<string, SharedAnswer>();
    for (const row of [...rows].sort((a, b) => a.key.localeCompare(b.key))) {
      const text = normalizeText(answers.get(row.key)!), id = hash([text]), old = distinct.get(id);
      if (old) old.keys.push(row.key); else distinct.set(id, { keys: [row.key], text });
      if (++work % 256 === 0) yield;
    }
    const variants = [...distinct.values()], jaccardValues: number[] = [], recallValues: number[] = [];
    records.set(inputKey, variants);
    if (variants.length > 1) for (const answer of variants) answer.terms = new Set((yield* lexicalSteps(answer.text)).terms);
    for (const answer of variants) {
      let jaccardSum = 0, recallSum = 0, support = 0;
      for (const peer of variants) {
        if (peer === answer) continue;
        let intersection = 0;
        const [small, large] = answer.terms!.size <= peer.terms!.size ? [answer.terms!, peer.terms!] : [peer.terms!, answer.terms!];
        for (const term of small) { intersection += Number(large.has(term)); if (++work % 1024 === 0) yield; }
        const union = answer.terms!.size + peer.terms!.size - intersection, denominator = 4 * peer.terms!.size + answer.terms!.size;
        jaccardSum += union ? intersection / union : 0; recallSum += denominator ? 5 * intersection / denominator : 0;
        agreement.comparisons++; recall.comparisons++;
        if (++support === 32) break;
      }
      const jaccard = support ? jaccardSum / support : 0, f2 = support ? recallSum / support : 0;
      jaccardValues.push(jaccard); recallValues.push(f2);
      for (const key of answer.keys) { agreement.scores.set(key, jaccard); recall.scores.set(key, f2); }
    }
    agreement.groupScores.set(inputKey, jaccardValues.reduce((a, b) => a + b, 0) / jaccardValues.length);
    recall.groupScores.set(inputKey, recallValues.reduce((a, b) => a + b, 0) / recallValues.length);
    if (++work % 64 === 0) yield;
  }
  return { agreement, recall, records };
}
