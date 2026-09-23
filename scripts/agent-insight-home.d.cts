export type EnvironmentValues = Readonly<Record<string, string | undefined>>;

export function assertSupportedHomeEnv(env?: EnvironmentValues): void;
export function expandHomePath(value: string, home?: string): string;
export function getAgentInsightHome(env?: EnvironmentValues, home?: string): string;
export function resolveDatabaseUrl(value: string | undefined, root?: string): string;
export function resolveStartupDatabaseUrl(fileEnv: EnvironmentValues, env?: EnvironmentValues, root?: string): string;
