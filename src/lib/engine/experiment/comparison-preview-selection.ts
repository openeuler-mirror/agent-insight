interface PreviewContext {
  user: string | null | undefined;
  agentName: string;
  type: string;
  groupA: string;
  groupB: string;
  datasetId: string;
  datasetCases?: readonly unknown[];
}

export function comparisonPreviewContextKey(context: PreviewContext): string {
  return JSON.stringify([
    context.user, context.agentName, context.type, context.groupA.trim(), context.groupB.trim(),
    context.datasetId, context.datasetCases || [],
  ]);
}

const annotationFields = ['referenceOutput', 'datasetInput', 'evaluatorContext', 'faultInjectionType', 'values'] as const;
type PreviewCase = { executionId: string; input: string } & Partial<Record<typeof annotationFields[number], unknown>>;

export function mergeComparisonPreviewSelection<T extends PreviewCase>(
  previousContext: string | null,
  nextContext: string,
  previous: ReadonlyMap<string, T>,
  candidates: readonly T[],
): Map<string, T> {
  return new Map(candidates.map(candidate => {
    const prior = previousContext === nextContext ? previous.get(candidate.executionId) : undefined;
    if (!prior || prior.input !== candidate.input) return [candidate.executionId, candidate];
    const annotations = Object.fromEntries(annotationFields.filter(key => key in prior).map(key => [key, prior[key]]));
    return [candidate.executionId, { ...candidate, ...annotations }];
  }));
}
