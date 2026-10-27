import { createHash } from 'node:crypto';
import { normalizeText } from '../../../src/lib/trace-datasets/sampling';

export function baseHashes(text: string): Uint32Array {
  const points = [...normalizeText(text)];
  const grams = points.length < 5 ? [points.join('')] : Array.from({ length: points.length - 4 }, (_, i) => points.slice(i, i + 5).join(''));
  return Uint32Array.from([...new Set(grams.filter(Boolean))].map(gram => {
    let h = createHash('sha256').update(JSON.stringify(['mh-base-v1', gram])).digest().readUInt32BE(0);
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35); return (h ^ (h >>> 16)) >>> 0;
  }));
}
export function signatureFromBase(base: Uint32Array, seed: number): Uint32Array {
  const result = new Uint32Array(128).fill(0xffffffff);
  for (let j = 0; j < 128; j++) {
    const bytes = createHash('sha256').update(JSON.stringify(['mh-affine32-v1', seed, j])).digest();
    const a = (bytes.readUInt32BE(0) | 1) >>> 0, b = bytes.readUInt32BE(4);
    for (const h of base) { const value = (Math.imul(a, h) + b) >>> 0; if (value < result[j]) result[j] = value; }
  }
  return result;
}
