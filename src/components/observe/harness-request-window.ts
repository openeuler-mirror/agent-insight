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

export const DEFAULT_REQUEST_WINDOW_SIZE = 20;

export type RequestWindow = { startIndex: number; endIndex: number };

export function clampRequestWindow(count: number, window?: RequestWindow): RequestWindow {
  if (count <= 0) return { startIndex: 0, endIndex: -1 };
  const valid = window && Number.isSafeInteger(window.startIndex) && Number.isSafeInteger(window.endIndex)
    && window.endIndex >= window.startIndex;
  const size = Math.min(count, valid ? window.endIndex - window.startIndex + 1 : DEFAULT_REQUEST_WINDOW_SIZE);
  const startIndex = Math.max(0, Math.min(valid ? window.startIndex : 0, count - size));
  return { startIndex, endIndex: startIndex + size - 1 };
}

export function revealRequestWindow(count: number, index: number, window?: RequestWindow): RequestWindow {
  const current = clampRequestWindow(count, window);
  if (index < 0 || index >= count || index >= current.startIndex && index <= current.endIndex) return current;
  const size = current.endIndex - current.startIndex + 1;
  return clampRequestWindow(count, { startIndex: index - Math.floor(size / 2), endIndex: index - Math.floor(size / 2) + size - 1 });
}

export function shiftRequestWindow(count: number, window: RequestWindow, direction: -1 | 1): RequestWindow {
  const current = clampRequestWindow(count, window);
  const offset = direction * (current.endIndex - current.startIndex + 1);
  return clampRequestWindow(count, { startIndex: current.startIndex + offset, endIndex: current.endIndex + offset });
}
