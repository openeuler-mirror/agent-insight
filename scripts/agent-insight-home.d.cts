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

export type EnvironmentValues = Readonly<Record<string, string | undefined>>;

export function assertSupportedHomeEnv(env?: EnvironmentValues): void;
export function expandHomePath(value: string, home?: string): string;
export function getAgentInsightHome(env?: EnvironmentValues, home?: string): string;
export function resolveDatabaseUrl(value: string | undefined, root?: string): string;
export function resolveStartupDatabaseUrl(fileEnv: EnvironmentValues, env?: EnvironmentValues, root?: string): string;
