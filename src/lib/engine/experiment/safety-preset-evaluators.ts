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

import type { EvaluatorOutput } from '../../evaluators/eval-output';
import type { FaithfulPresetContext } from './faithful-preset-evaluators';
import {
  CRIMINALITY_PRESET_ID,
  runCriminalityPreset,
} from './safety-criminality';
import {
  HARMFULNESS_PRESET_ID,
  runHarmfulnessPreset,
} from './safety-harmfulness';
import {
  MALICIOUSNESS_PRESET_ID,
  runMaliciousnessPreset,
} from './safety-maliciousness';
import {
  runTextRefusalPreset,
  TEXT_REFUSAL_PRESET_ID,
} from './safety-text-refusal';

export const SAFETY_PRESET_IDS = [
  MALICIOUSNESS_PRESET_ID,
  HARMFULNESS_PRESET_ID,
  CRIMINALITY_PRESET_ID,
  TEXT_REFUSAL_PRESET_ID,
] as const;

export type SafetyPresetId = (typeof SAFETY_PRESET_IDS)[number];

export function isSafetyPresetId(id: string): id is SafetyPresetId {
  return (SAFETY_PRESET_IDS as readonly string[]).includes(id);
}

export function runSafetyPreset(
  id: SafetyPresetId,
  user: string,
  ctx: FaithfulPresetContext,
): Promise<EvaluatorOutput> {
  switch (id) {
    case MALICIOUSNESS_PRESET_ID:
      return runMaliciousnessPreset(user, ctx);
    case HARMFULNESS_PRESET_ID:
      return runHarmfulnessPreset(user, ctx);
    case CRIMINALITY_PRESET_ID:
      return runCriminalityPreset(user, ctx);
    case TEXT_REFUSAL_PRESET_ID:
      return runTextRefusalPreset(user, ctx);
  }
}
