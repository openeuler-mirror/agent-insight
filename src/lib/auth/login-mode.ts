/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
