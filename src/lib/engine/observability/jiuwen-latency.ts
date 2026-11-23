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

import { deriveExecutionTiming } from './execution-timing';

export function jiuwenLegacyLatencyCorrection(latency: number | null | undefined, interactions: unknown) {
    if (latency == null || !Number.isFinite(latency) || latency <= 0 || !Array.isArray(interactions)) return undefined;
    const durationMs = deriveExecutionTiming(interactions).elapsedDurationMs;
    // Jiuwen interaction timestamps are floored to milliseconds; a one-ms span can be sub-ms work.
    if (durationMs === undefined || durationMs <= 1) return undefined;
    if (Math.abs(latency - durationMs) <= Math.max(0.001, durationMs * 0.01)) return undefined;
    const milliseconds = latency * 1000;
    if (!Number.isFinite(milliseconds)) return undefined;
    // Root spans can include a small amount of work outside the visible interactions.
    if (Math.abs(milliseconds - durationMs) > Math.max(2, milliseconds * 0.02)) return undefined;
    return { latencyMs: milliseconds, evidenceDurationMs: durationMs };
}
