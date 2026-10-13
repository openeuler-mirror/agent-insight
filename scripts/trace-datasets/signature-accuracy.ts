import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { signature, textDistance } from '../../src/lib/trace-datasets/sampling';
function grams(text: string) { const points = [...text]; return new Set(points.length < 5 ? [text] : points.slice(4).map((_, i) => points.slice(i, i + 5).join(''))); }
function randomText(length: number, key: string, language: string) {
  let out = '', counter = 0;
  while (out.length < length) { const bytes = createHash('sha256').update(`${key}:${counter++}`).digest(); for (const b of bytes) out += String.fromCodePoint((language === 'zh' ? 0x4e00 : 0x61) + b % (language === 'zh' ? 256 : 26)); }
  return out.slice(0, length);
}
const started = performance.now(), buckets = [];
for (const size of [50, 500, 2000]) for (const language of ['en', 'zh']) for (const overlap of [.25, .5, .8]) {
  const errors: number[] = [];
  for (let i = 0; i < 100; i++) {
    const common = randomText(Math.floor(size * overlap), `common-${i}`, language);
    const a = common + randomText(size - common.length, `a-${i}`, language), b = common + randomText(size - common.length, `b-${i}`, language);
    const ga = grams(a), gb = grams(b); let intersection = 0; for (const g of ga) if (gb.has(g)) intersection++;
    const actual = intersection / (ga.size + gb.size - intersection), seed = [0, 42, 100, 119][i % 4];
    errors.push(1 - textDistance(signature(a, seed), signature(b, seed)) - actual);
  }
  const abs = errors.map(Math.abs).sort((a, b) => a - b), bias = errors.reduce((a, b) => a + b, 0) / errors.length, mae = abs.reduce((a, b) => a + b, 0) / abs.length;
  buckets.push({ size, language, overlap, pairs: errors.length, bias, mae, rmse: Math.sqrt(errors.reduce((a, b) => a + b * b, 0) / errors.length), p95: abs[94], pass: mae <= .06 && Math.abs(bias) <= .03 });
}
console.log(JSON.stringify({ protocol: 'mh-affine32-v1', seeds: [0,42,100,119], milliseconds: performance.now() - started, pass: buckets.every(b => b.pass), buckets, limitation: 'Synthetic character distributions; not a guarantee for arbitrary business language or billion-gram collision behavior.' }, null, 2));
