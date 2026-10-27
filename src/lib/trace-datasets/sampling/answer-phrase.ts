import { type AgreementFeatures } from './answer-consensus';
import { type SharedAnswers } from './answer-shared';

export function* phraseFeaturesSteps(mode: 'phrase' | 'repeat' | 'dual', base: AgreementFeatures, records: SharedAnswers['records']) {
  const phraseScores = new Map<string, number>(), repeatScores = new Map<string, number>();
  const phraseGroups = new Map<string, number>(), repeatGroups = new Map<string, number>();
  let work = 0, comparisons = 0;
  for (const [inputKey, variants] of records) {
    if (variants.length === 1) {
      for (const key of variants[0].keys) { phraseScores.set(key, base.scores.get(key)!); repeatScores.set(key, base.scores.get(key)!); }
      phraseGroups.set(inputKey, base.groupScores.get(inputKey)!); repeatGroups.set(inputKey, base.groupScores.get(inputKey)!);
      if (++work % 64 === 0) yield;
      continue;
    }
    const features: { grams: Set<string>; count: number }[] = [];
    for (const variant of variants) {
      const grams = new Set<string>(); let previous: string | undefined, count = 0;
      for (const match of variant.text.toLowerCase().matchAll(/\p{Script=Han}|[\p{L}\p{M}\p{N}]+/gu)) {
        const token = match[0];
        if (previous !== undefined) { grams.add(previous + '\0' + token); count++; }
        previous = token; if (++work % 1024 === 0) yield;
      }
      features.push({ grams, count });
    }
    const hasEvidence = features.some(f => f.count > 0), ps: number[] = [], rs: number[] = [];
    for (let i = 0; i < variants.length; i++) {
      let sum = 0, support = 0;
      if (mode !== 'repeat' && hasEvidence) for (let j = 0; j < variants.length; j++) {
        if (i === j) continue;
        const a = features[i].grams, b = features[j].grams, [small, large] = a.size <= b.size ? [a, b] : [b, a]; let intersection = 0;
        for (const gram of small) { intersection += Number(large.has(gram)); if (++work % 1024 === 0) yield; }
        const denominator = 4 * b.size + a.size; sum += denominator ? 5 * intersection / denominator : 0; comparisons++;
        if (++support === 32) break;
      }
      const original = base.scores.get(variants[i].keys[0])!;
      const p = hasEvidence && mode !== 'repeat' ? .8 * original + .2 * (support ? sum / support : 0) : original;
      const d = features[i].count ? features[i].grams.size / features[i].count : 0;
      const r = hasEvidence ? .9 * original + .1 * d : original;
      ps.push(p); rs.push(r);
      for (const key of variants[i].keys) { phraseScores.set(key, p); repeatScores.set(key, r); }
      if (++work % 64 === 0) yield;
    }
    phraseGroups.set(inputKey, ps.reduce((a, b) => a + b, 0) / ps.length);
    repeatGroups.set(inputKey, rs.reduce((a, b) => a + b, 0) / rs.length);
  }
  const phrase: AgreementFeatures = { groups: base.groups, scores: phraseScores, groupScores: phraseGroups, comparisons };
  const repeat: AgreementFeatures = { groups: base.groups, scores: repeatScores, groupScores: repeatGroups, comparisons: 0 };
  const dual: AgreementFeatures = {
    groups: base.groups, comparisons,
    scores: new Map([...phraseScores].map(([key, score]) => [key, (score + repeatScores.get(key)!) / 2])),
    groupScores: new Map([...phraseGroups].map(([key, score]) => [key, (score + repeatGroups.get(key)!) / 2])),
  };
  return { primary: mode === 'phrase' ? phrase : mode === 'repeat' ? repeat : dual, phrase, repeat };
}
