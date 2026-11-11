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

/**
 * 解析版本号：接受 "1.14.39"、"v0.82.1"、"opencode 1.14.39" 等包含三段语义版本的值。
 * 只有 "1" / "1.2" 这类不完整版本也会被补齐为 x.y.0，便于与最低版本比较。
 */
export function parseVersion(value: unknown): [number, number, number] | null {
  const text = String(value ?? '').trim();
  if (!text) return null;

  const full = /(\d+)\.(\d+)\.(\d+)(?![0-9])/.exec(text);
  if (full) return [Number(full[1]), Number(full[2]), Number(full[3])];

  const partial = /(\d+)\.(\d+)(?![0-9.])/.exec(text);
  if (partial) return [Number(partial[1]), Number(partial[2]), 0];

  const major = /^v?(\d+)$/.exec(text);
  if (major) return [Number(major[1]), 0, 0];

  return null;
}

export function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

/** 无法解析实际版本时返回 false：不能把未知版本当成兼容。 */
export function satisfiesMinimum(actual: unknown, minimum: unknown): boolean {
  if (minimum == null || minimum === '') return parseVersion(actual) !== null;
  const min = parseVersion(minimum);
  const current = parseVersion(actual);
  if (!min || !current) return false;
  return compareVersions(current, min) >= 0;
}
