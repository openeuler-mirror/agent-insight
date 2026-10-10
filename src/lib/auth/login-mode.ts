export type LoginMode = 'standalone' | 'organization' | 'idaas_oauth';

export class LoginModeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginModeConfigurationError';
  }
}

export function resolveLoginMode(env: Record<string, string | undefined> = process.env): LoginMode {
  const configuredMode = String(env.LOGIN_MODE || '').trim().toLowerCase();
  const organizationMode = env.ORGANIZATION_MODE === 'true';

  if (configuredMode && configuredMode !== 'standalone' && configuredMode !== 'idaas_oauth') {
    throw new LoginModeConfigurationError(`Unsupported LOGIN_MODE: ${configuredMode}`);
  }

  if (configuredMode === 'idaas_oauth' && organizationMode) {
    throw new LoginModeConfigurationError(
      'LOGIN_MODE=idaas_oauth cannot be combined with ORGANIZATION_MODE=true',
    );
  }

  if (organizationMode) return 'organization';
  if (configuredMode === 'idaas_oauth') return 'idaas_oauth';
  return 'standalone';
}
