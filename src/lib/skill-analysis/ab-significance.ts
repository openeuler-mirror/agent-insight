const LANCZOS_COEFFICIENTS = [
  676.5203681218851,
  -1259.1392167224028,
  771.3234287776531,
  -176.6150291621406,
  12.507343278686905,
  -0.13857109526572012,
  9.984369578019572e-6,
  1.5056327351493116e-7,
];

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleVariance(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  const squaredDiff = values.reduce((sum, value) => sum + ((value - avg) ** 2), 0);
  return squaredDiff / (values.length - 1);
}

function logGamma(value: number): number {
  if (value < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  }

  let x = 0.9999999999998099;
  const adjusted = value - 1;
  for (let i = 0; i < LANCZOS_COEFFICIENTS.length; i += 1) {
    x += LANCZOS_COEFFICIENTS[i] / (adjusted + i + 1);
  }
  const t = adjusted + LANCZOS_COEFFICIENTS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (adjusted + 0.5) * Math.log(t) - t + Math.log(x);
}

function betacf(a: number, b: number, x: number): number {
  const maxIterations = 200;
  const epsilon = 3e-7;
  const tiny = 1e-30;
  let qab = a + b;
  let qap = a + 1;
  let qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= maxIterations; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;

    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < epsilon) break;
  }

  return h;
}

function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b)
    + a * Math.log(x)
    + b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betacf(a, b, x)) / a;
  }
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

function studentTCdf(t: number, degreesOfFreedom: number): number {
  if (!Number.isFinite(t) || !Number.isFinite(degreesOfFreedom) || degreesOfFreedom <= 0) {
    return Number.NaN;
  }
  if (t === 0) return 0.5;
  const x = degreesOfFreedom / (degreesOfFreedom + t * t);
  const ib = regularizedIncompleteBeta(x, degreesOfFreedom / 2, 0.5);
  return t > 0 ? 1 - ib / 2 : ib / 2;
}

export function welchTTestPValue(sampleA: number[], sampleB: number[]): number | null {
  if (sampleA.length === 0 || sampleB.length === 0) return null;

  const meanA = mean(sampleA);
  const meanB = mean(sampleB);
  if (sampleA.length < 2 || sampleB.length < 2) {
    return meanA === meanB ? 1 : 0;
  }

  const varianceA = sampleVariance(sampleA, meanA);
  const varianceB = sampleVariance(sampleB, meanB);
  const normalizedVarianceA = varianceA / sampleA.length;
  const normalizedVarianceB = varianceB / sampleB.length;
  const denominator = Math.sqrt(normalizedVarianceA + normalizedVarianceB);

  if (!Number.isFinite(denominator) || denominator === 0) {
    return meanA === meanB ? 1 : 0;
  }

  const tStatistic = (meanB - meanA) / denominator;
  const numerator = (normalizedVarianceA + normalizedVarianceB) ** 2;
  const denominatorDf =
    ((normalizedVarianceA ** 2) / (sampleA.length - 1))
    + ((normalizedVarianceB ** 2) / (sampleB.length - 1));
  const degreesOfFreedom = denominatorDf > 0 ? numerator / denominatorDf : sampleA.length + sampleB.length - 2;
  const cdf = studentTCdf(Math.abs(tStatistic), degreesOfFreedom);

  if (!Number.isFinite(cdf)) return null;
  const pValue = 2 * (1 - cdf);
  return Math.max(0, Math.min(1, Number(pValue.toFixed(6))));
}

export function formatPValueLabel(pValue: number | null): string {
  if (pValue == null) return '待计算';
  if (pValue < 0.01) return 'p < 0.01 ✓✓';
  if (pValue < 0.05) return 'p < 0.05 ✓';
  return `p = ${pValue.toFixed(3)}`;
}
