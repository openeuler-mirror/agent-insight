export function executionModelMatches(requested: string, actual: string): boolean {
  return actual === requested || actual === requested.slice(requested.indexOf('/') + 1);
}

export function executionModelMismatch(requested: string | null | undefined, actualModels: Array<string | null | undefined>): boolean {
  return Boolean(requested && actualModels.some((actual) => actual && !executionModelMatches(requested, actual)));
}
