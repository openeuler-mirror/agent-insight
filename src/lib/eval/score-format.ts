export function fmtPercentScore(score: number | null | undefined, digits = 1): string {
    if (score == null || Number.isNaN(score)) return '--';
    return (score * 100).toFixed(digits);
}
