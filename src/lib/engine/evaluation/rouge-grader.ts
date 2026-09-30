export interface RougeGraderConfig {
  locale?: string;
  lowercase?: boolean;
  tokenizer?: (text: string) => string[];
}

export interface RougeNgramScore {
  precision: number;
  recall: number;
  f1: number;
  overlapCount: number;
  generatedCount: number;
  referenceCount: number;
}

export interface RougeLScore {
  precision: number;
  recall: number;
  f1: number;
  lcsLength: number;
  generatedCount: number;
  referenceCount: number;
}

export interface RougeGraderResult {
  score: number;
  reason: {
    tokenizer: string;
    generatedTokenCount: number;
    referenceTokenCount: number;
    rouge1: RougeNgramScore;
    rouge2: RougeNgramScore;
    rougeL: RougeLScore;
  };
}

const HAN = /\p{Script=Han}/u;
const WORD_PART = /[\p{L}\p{M}\p{N}_]/u;

function normalizeText(text: string, lowercase: boolean, locale: string): string {
  const normalized = text.normalize('NFKC');
  return lowercase ? normalized.toLocaleLowerCase(locale) : normalized;
}

function characterTokenize(text: string): string[] {
  return Array.from(text).filter((char) => WORD_PART.test(char));
}

function fallbackTokenize(text: string): string[] {
  const tokens: string[] = [];
  let buffered = '';
  const flush = () => {
    if (buffered) tokens.push(buffered);
    buffered = '';
  };
  for (const char of text) {
    if (HAN.test(char)) {
      flush();
      tokens.push(char);
    } else if (WORD_PART.test(char)) {
      buffered += char;
    } else {
      flush();
    }
  }
  flush();
  return tokens;
}

export function tokenizeRougeText(
  text: string,
  config: Omit<RougeGraderConfig, 'tokenizer'> = {},
): { tokens: string[]; tokenizer: string } {
  const locale = config.locale ?? 'zh';
  const normalized = normalizeText(text, config.lowercase ?? true, locale);
  if (HAN.test(normalized)) {
    return {
      tokens: characterTokenize(normalized),
      tokenizer: 'unicode-char(cjk)',
    };
  }
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(locale, { granularity: 'word' });
    return {
      tokens: Array.from(segmenter.segment(normalized))
        .filter((part) => part.isWordLike)
        .map((part) => part.segment),
      tokenizer: `Intl.Segmenter(${locale}, word)`,
    };
  }
  return { tokens: fallbackTokenize(normalized), tokenizer: 'unicode-mixed-char-word-fallback' };
}

function harmonicMean(precision: number, recall: number): number {
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

function ngramCounts(tokens: string[], size: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (let index = 0; index + size <= tokens.length; index++) {
    const key = JSON.stringify(tokens.slice(index, index + size));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function scoreNgrams(generated: string[], reference: string[], size: number): RougeNgramScore {
  const generatedCounts = ngramCounts(generated, size);
  const referenceCounts = ngramCounts(reference, size);
  let overlapCount = 0;
  for (const [gram, count] of generatedCounts) {
    overlapCount += Math.min(count, referenceCounts.get(gram) ?? 0);
  }
  const generatedCount = Math.max(0, generated.length - size + 1);
  const referenceCount = Math.max(0, reference.length - size + 1);
  const precision = generatedCount === 0 ? 0 : overlapCount / generatedCount;
  const recall = referenceCount === 0 ? 0 : overlapCount / referenceCount;
  return {
    precision,
    recall,
    f1: harmonicMean(precision, recall),
    overlapCount,
    generatedCount,
    referenceCount,
  };
}

function lcsLength(left: string[], right: string[]): number {
  if (left.length > right.length) return lcsLength(right, left);
  let previous = new Uint32Array(left.length + 1);
  let current = new Uint32Array(left.length + 1);
  for (const rightToken of right) {
    for (let index = 1; index <= left.length; index++) {
      current[index] = left[index - 1] === rightToken
        ? previous[index - 1] + 1
        : Math.max(previous[index], current[index - 1]);
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  return previous[left.length];
}

function scoreRougeL(generated: string[], reference: string[]): RougeLScore {
  const length = lcsLength(generated, reference);
  const precision = generated.length === 0 ? 0 : length / generated.length;
  const recall = reference.length === 0 ? 0 : length / reference.length;
  return {
    precision,
    recall,
    f1: harmonicMean(precision, recall),
    lcsLength: length,
    generatedCount: generated.length,
    referenceCount: reference.length,
  };
}

function identicalMetric(count: number): RougeNgramScore {
  return {
    precision: 1,
    recall: 1,
    f1: 1,
    overlapCount: count,
    generatedCount: count,
    referenceCount: count,
  };
}

export function gradeRouge(
  generatedText: string,
  referenceText: string,
  config: RougeGraderConfig = {},
): RougeGraderResult {
  const customTokenizer = config.tokenizer;
  const locale = config.locale ?? 'zh';
  const lowercase = config.lowercase ?? true;
  const normalizedGenerated = normalizeText(generatedText, lowercase, locale);
  const normalizedReference = normalizeText(referenceText, lowercase, locale);
  // 中文没有跨运行时稳定一致的词边界。任一侧含汉字时，两边统一按 Unicode
  // 字符计算 ROUGE-char；纯英文仍使用 word segmentation，避免改变既有英文口径。
  const useCjkCharacterTokens = !customTokenizer
    && (HAN.test(normalizedGenerated) || HAN.test(normalizedReference));
  const generated = customTokenizer
    ? customTokenizer(generatedText)
    : useCjkCharacterTokens
      ? { tokens: characterTokenize(normalizedGenerated), tokenizer: 'unicode-char(cjk)' }
      : tokenizeRougeText(generatedText, config);
  const reference = customTokenizer
    ? customTokenizer(referenceText)
    : useCjkCharacterTokens
      ? { tokens: characterTokenize(normalizedReference), tokenizer: 'unicode-char(cjk)' }
      : tokenizeRougeText(referenceText, config);
  const generatedTokens = Array.isArray(generated) ? generated : generated.tokens;
  const referenceTokens = Array.isArray(reference) ? reference : reference.tokens;
  const tokenizer = customTokenizer ? 'custom' : (generated as { tokenizer: string }).tokenizer;

  const identical = generatedTokens.length > 0
    && generatedTokens.length === referenceTokens.length
    && generatedTokens.every((token, index) => token === referenceTokens[index]);
  const rouge1 = identical ? identicalMetric(generatedTokens.length) : scoreNgrams(generatedTokens, referenceTokens, 1);
  const rouge2 = identical
    ? identicalMetric(Math.max(0, generatedTokens.length - 1))
    : scoreNgrams(generatedTokens, referenceTokens, 2);
  const rougeL = identical
    ? {
        precision: 1,
        recall: 1,
        f1: 1,
        lcsLength: generatedTokens.length,
        generatedCount: generatedTokens.length,
        referenceCount: referenceTokens.length,
      }
    : scoreRougeL(generatedTokens, referenceTokens);

  return {
    score: (rouge1.f1 + rouge2.f1 + rougeL.f1) / 3,
    reason: {
      tokenizer,
      generatedTokenCount: generatedTokens.length,
      referenceTokenCount: referenceTokens.length,
      rouge1,
      rouge2,
      rougeL,
    },
  };
}
