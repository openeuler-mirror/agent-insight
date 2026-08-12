export function buildOpencodeSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    ...overrides,
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  };
}
