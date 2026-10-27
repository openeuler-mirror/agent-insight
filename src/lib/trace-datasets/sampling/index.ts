import { createHash } from 'node:crypto';

export const LEGACY_POLICY = Object.freeze({ version: 'trace-coverage-v4', signatureProtocol: 'mh-affine32-v1', seed: 42, rho: 0.2 });
export const COVERAGE_POLICY = Object.freeze({ ...LEGACY_POLICY, version: 'trace-coverage-v5' });
export const POLICY = LEGACY_POLICY;
export type Policy = { version: string; seed: number; rho: number };
export type LexicalFeatures = { terms: string[]; tokenCount: number };
export type Path = { key: string; cells: string[]; knownDimensions: number };
export type Candidate = { key: string; inputKey: string; task: string; signature: Uint32Array; lexical?: LexicalFeatures; paths: Path[] };
export type Selection = { key: string; path: Path; reason: string };
export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const normalizeText = (value: string) => value.replace(/\r\n?/g, '\n').normalize('NFC');

export function* lexicalSteps(text: string): Generator<void, LexicalFeatures> {
  const terms = new Set<string>();
  let tokenCount = 0;
  for (const match of normalizeText(text).toLowerCase().matchAll(/\p{Script=Han}|[\p{L}\p{M}\p{N}]+/gu)) {
    terms.add(match[0]);
    if (++tokenCount % 1024 === 0) yield;
  }
  return { terms: [...terms], tokenCount };
}

export function lexicalFeatures(text: string): LexicalFeatures {
  const steps = lexicalSteps(text);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}

export function lengthBucket(tokenCount: number): number {
  return tokenCount <= 32 ? 0 : tokenCount <= 128 ? 1 : tokenCount <= 512 ? 2 : 3;
}

export function* signatureSteps(text: string, seed = 42): Generator<void, Uint32Array> {
  const coefficients = Array.from({ length: 128 }, (_, j) => {
    const bytes = createHash('sha256').update(JSON.stringify(['mh-affine32-v1', seed, j])).digest();
    return [(bytes.readUInt32BE(0) | 1) >>> 0, bytes.readUInt32BE(4)];
  });
  const result = new Uint32Array(128).fill(0xffffffff);
  let window: string[] = [];
  const update = (gram: string) => {
    let h = createHash('sha256').update(JSON.stringify(['mh-base-v1', gram])).digest().readUInt32BE(0);
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35); h = (h ^ (h >>> 16)) >>> 0;
    for (let j = 0; j < 128; j++) {
      const v = (Math.imul(coefficients[j][0], h) + coefficients[j][1]) >>> 0;
      if (v < result[j]) result[j] = v;
    }
  };
  let grams = 0, scanned = 0;
  for (const cp of normalizeText(text)) {
    window.push(cp);
    if (++scanned % 1024 === 0) yield;
    if (window.length === 5) { update(window.join('')); grams++; window = window.slice(1); }
  }
  if (!grams && window.length) update(window.join(''));
  return result;
}

export function signature(text: string, seed = 42): Uint32Array {
  const steps = signatureSteps(text, seed);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}

export function textDistance(a: Uint32Array, b: Uint32Array): number {
  let equal = 0;
  for (let i = 0; i < 128; i++) if (a[i] === b[i]) equal++;
  return 1 - equal / 128;
}

export function taskType(input: string): string {
  const rules: [string, RegExp][] = [
    ['coding', /\b(code|debug|implement|refactor|function|program|script|sql)\b|代码|编程|函数|修复.*bug/i],
    ['data_processing', /\b(analy[sz]e|extract|classify|convert|calculate|csv|json)\b|分析|提取|分类|计算|转换/i],
    ['workflow_action', /\b(send|schedule|deploy|install|delete|create.*ticket)\b|发送|部署|安装|删除|创建.*工单/i],
    ['content_generation', /\b(write|draft|compose|translate|summari[sz]e)\b|写作|撰写|翻译|总结|摘要/i],
    ['information_lookup', /\b(what|who|when|where|why|how|find|search|explain)\b|查询|搜索|什么|如何|解释|为什么/i],
  ];
  return rules.find(([, rule]) => rule.test(input))?.[0] || 'unknown';
}

export function* sampleSteps(candidates: Candidate[], limit: number, policy: Policy = POLICY, experiment: { coverage?: boolean; stratify?: boolean } = {}) {
  if (!candidates.length) throw new Error('NO_VALID_SAMPLES');
  if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isFinite(policy.rho) || policy.rho < 0 || policy.rho > 1 || !Number.isInteger(policy.seed) || (policy.version !== COVERAGE_POLICY.version && policy.version !== LEGACY_POLICY.version)) throw new Error('INVALID_CONFIG');
  const modern = policy.version === COVERAGE_POLICY.version;
  const useCoverage = modern && experiment.coverage !== false;
  const stratify = modern && experiment.stratify !== false;
  const rankCache = new Map<string, string>();
  const rank = (phase: string, key: string) => {
    const id = `${phase}:${key}`;
    let value = rankCache.get(id);
    if (!value) { value = hash([policy.version, policy.seed, phase, key]); rankCache.set(id, value); }
    return value;
  };
  const compare = (phase: string, a: string, b: string) => rank(phase, a).localeCompare(rank(phase, b)) || a.localeCompare(b);
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) { const group = groups.get(c.inputKey) || []; group.push(c); groups.set(c.inputKey, group); }
  for (const group of groups.values()) group.sort((a, b) => compare('answer', a.key, b.key));
  const groupTasks = new Map([...groups].map(([key, group]) => {
    const tasks = new Set(group.map(c => c.task).filter(t => t !== 'unknown'));
    return [key, tasks.size === 1 ? [...tasks][0] : 'unknown'];
  }));
  const keys = [...groups.keys()], index = new Map(keys.map((key, i) => [key, i]));
  const gains = new Int32Array(keys.length), buckets = new Uint8Array(keys.length), lengths = new Float64Array(keys.length);
  const bucketSizes = [0, 0, 0, 0], bucketCounts = [0, 0, 0, 0], bucketTokens = [0, 0, 0, 0], spentTokens = [0, 0, 0, 0];
  const postings = new Map<string, number[]>();
  let work = 0;
  if (modern) for (const [key, group] of groups) {
    const features = group[0].lexical;
    if (!features || !Number.isSafeInteger(features.tokenCount) || features.tokenCount < features.terms.length) throw new Error('SOURCE_CORRUPT');
    const i = index.get(key)!;
    const terms = new Set(features.terms);
    gains[i] = terms.size;
    lengths[i] = features.tokenCount;
    buckets[i] = lengthBucket(features.tokenCount);
    bucketSizes[buckets[i]]++;
    bucketTokens[buckets[i]] += features.tokenCount;
    if (useCoverage) for (const term of terms) {
      if (++work % 1024 === 0) yield;
      const members = postings.get(term);
      if (members) members.push(i); else postings.set(term, [i]);
    }
  }
  const uniqueTarget = Math.min(groups.size, limit);
  const quotas = bucketSizes.map(n => Math.floor(n * uniqueTarget / groups.size));
  const remainderOrder = [0, 1, 2, 3].sort((a, b) => (bucketSizes[b] * uniqueTarget % groups.size) - (bucketSizes[a] * uniqueTarget % groups.size) || a - b);
  if (modern) for (const bucket of remainderOrder.slice(0, uniqueTarget - quotas.reduce((a, b) => a + b, 0))) quotas[bucket]++;
  const tokenBudgets = bucketSizes.map((n, b) => n ? Math.ceil(bucketTokens[b] * quotas[b] / n) : 0);
  const byLength = [0, 1, 2, 3].map(b => modern ? keys.filter(key => buckets[index.get(key)!] === b).sort((a, c) => lengths[index.get(a)!] - lengths[index.get(c)!] || a.localeCompare(c)) : []);
  const selected: Selection[] = [], chosen = new Set<string>(), covered = new Set<string>();
  const groupCounts = new Map<string, number>();
  const distances = new Map([...groups.keys()].map(k => [k, 1]));
  const distanceSources: Uint32Array[] = [];
  const distanceThrough = new Map<string, number>();
  const distance = (key: string) => {
    if (useCoverage) {
      let value = distances.get(key)!;
      for (let i = distanceThrough.get(key) || 0; i < distanceSources.length; i++) value = Math.min(value, textDistance(groups.get(key)![0].signature, distanceSources[i]));
      distances.set(key, value); distanceThrough.set(key, distanceSources.length);
    }
    return distances.get(key)!;
  };
  const delta = (p: Path) => p.cells.reduce((n, cell) => n + Number(!covered.has(cell)), 0);
  const representative = (c: Candidate) => [...c.paths].sort((a, b) => delta(b) - delta(a) || b.knownDimensions - a.knownDimensions || compare('path', a.key, b.key))[0];
  const add = function* (c: Candidate, reason: string, path = representative(c)): Generator<void, void> {
    if (!path || chosen.has(c.key)) throw new Error('SOURCE_CORRUPT');
    selected.push({ key: c.key, path, reason }); chosen.add(c.key);
    path.cells.forEach(cell => covered.add(cell));
    const count = groupCounts.get(c.inputKey) || 0;
    groupCounts.set(c.inputKey, count + 1);
    if (!count && modern) {
      const i = index.get(c.inputKey)!;
      bucketCounts[buckets[i]]++;
      spentTokens[buckets[i]] += lengths[i];
      if (useCoverage) distanceSources.push(c.signature);
      if (useCoverage) for (const term of c.lexical!.terms) {
        const members = postings.get(term);
        if (!members) continue;
        for (const i of members) { if (++work % 1024 === 0) yield; gains[i]--; }
        postings.delete(term);
      }
    }
    let visited = 0;
    if (!count && !useCoverage) for (const [key, group] of groups) {
      if (++visited % 256 === 0) yield;
      if (!groupCounts.has(key)) distances.set(key, Math.min(distances.get(key)!, textDistance(c.signature, group[0].signature)));
    }
  };
  const total = Math.min(candidates.length, limit);
  const knownTasks = [...new Set([...groupTasks.values()].filter(t => t !== 'unknown'))].sort((a, b) => compare('task', a, b));
  const floor = Math.min(knownTasks.length, total);
  const budget = candidates.some(c => c.paths.some(p => p.cells.length)) ? Math.min(Math.floor(policy.rho * total), total - floor) : 0;
  const nextGroup = function* (task?: string): Generator<void, string | undefined> {
    let best: string | undefined, relaxed: string | undefined;
    const eligibleBuckets = new Set<number>();
    if (stratify && !task) for (const key of keys) {
      if (++work % 256 === 0) yield;
      const bucket = buckets[index.get(key)!];
      if (!groupCounts.has(key) && bucketCounts[bucket] < quotas[bucket]) eligibleBuckets.add(bucket);
    }
    const cheapest = new Set<string>(), cheapestSums = [0, 0, 0, 0], nextLengths = [0, 0, 0, 0];
    if (stratify) for (let b = 0; b < 4; b++) {
      const needed = Math.max(0, quotas[b] - bucketCounts[b] - 1);
      let found = 0;
      for (const key of byLength[b]) {
        if (++work % 256 === 0) yield;
        if (groupCounts.has(key)) continue;
        if (found++ < needed) { cheapest.add(key); cheapestSums[b] += lengths[index.get(key)!]; }
        else { nextLengths[b] = lengths[index.get(key)!]; break; }
      }
    }
    const better = (key: string, other: string | undefined) => {
      if (!other) return true;
      const gain = useCoverage ? gains[index.get(key)!] : 0, otherGain = useCoverage ? gains[index.get(other)!] : 0;
      return gain > otherGain || (gain === otherGain && (distance(key) > distance(other) || (distance(key) === distance(other) && compare('input', key, other) < 0)));
    };
    for (const key of groups.keys()) {
      if (++work % 256 === 0) yield;
      if (groupCounts.has(key) || (task && groupTasks.get(key) !== task)) continue;
      if (eligibleBuckets.size && !eligibleBuckets.has(buckets[index.get(key)!])) continue;
      const i = index.get(key)!, b = buckets[i], length = lengths[i];
      const rest = cheapestSums[b] + (cheapest.has(key) ? nextLengths[b] - length : 0);
      const fits = !stratify || (bucketCounts[b] < quotas[b] && spentTokens[b] + length + rest <= tokenBudgets[b]);
      if (fits) { if (better(key, best)) best = key; }
      else if (!relaxed || length < lengths[index.get(relaxed)!] || (length === lengths[index.get(relaxed)!] && better(key, relaxed))) relaxed = key;
    }
    return best || relaxed;
  };
  if (candidates.length <= limit) {
    for (const c of [...candidates].sort((a, b) => a.key.localeCompare(b.key))) yield* add(c, 'all_pairs');
  } else {
    for (const task of knownTasks.slice(0, floor)) { const key = yield* nextGroup(task); if (key) yield* add(groups.get(key)![0], 'task_floor'); }
    if (!modern) while (selected.length < total - budget) { const key = yield* nextGroup(); if (!key) break; yield* add(groups.get(key)![0], 'text_main'); }
    for (let i = 0; i < budget; i++) {
      let best: { c: Candidate; p: Path; delta: number } | undefined;
      for (const c of candidates) if (!chosen.has(c.key)) for (const p of c.paths) {
        if (++work % 256 === 0) yield;
        const gain = delta(p);
        if (gain > 0 && (!best || gain > best.delta || (gain === best.delta && (compare('behavior', c.key, best.c.key) || compare('path', p.key, best.p.key)) < 0))) best = { c, p, delta: gain };
      }
      if (!best) break;
      yield* add(best.c, 'behavior', best.p);
    }
    while (selected.length < total) {
      const key = yield* nextGroup();
      if (key) { yield* add(groups.get(key)![0], modern ? 'text_main' : 'text_return'); continue; }
      const refill = [...groups.keys()].filter(k => groups.get(k)!.some(c => !chosen.has(c.key)))
        .sort((a, b) => (groupCounts.get(a) || 0) - (groupCounts.get(b) || 0) || compare('refill-group', a, b))[0];
      yield* add(groups.get(refill)!.find(c => !chosen.has(c.key))!, 'variant_return');
    }
  }
  return { selected, counts: { candidates: candidates.length, inputs: groups.size, generated: selected.length, behaviorReserve: budget, behaviorReserveUsed: selected.filter(s => s.reason === 'behavior').length, coveredCells: covered.size } };
}

export function sample(candidates: Candidate[], limit: number, policy: Policy = POLICY, experiment: { coverage?: boolean; stratify?: boolean } = {}) {
  const steps = sampleSteps(candidates, limit, policy, experiment);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}
