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

export function generatedSessionSyncPolicy(
  selected: { kind: string; sessionId: string | null; skillName: string; version: number } | null,
  next: { id: string; source: string | null; skillName: string | null; workVersion: number | null },
) {
  if (next.source !== 'generated' || (selected && (selected.kind !== 'draft' || selected.sessionId !== next.id))) {
    return { follow: false, preserveView: true };
  }
  return { follow: true, preserveView: Boolean(selected && selected.skillName === next.skillName && selected.version === next.workVersion) };
}
