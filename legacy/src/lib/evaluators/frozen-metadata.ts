/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
import type { EvaluatorCard } from './custom-evaluator-model';

export function frozenEvaluatorCards(snapshot: unknown): EvaluatorCard[] {
  if (!snapshot || typeof snapshot !== 'object') return [];
  const frozen = (snapshot as {customEvaluatorSnapshots?:unknown}).customEvaluatorSnapshots;
  if (!frozen || typeof frozen !== 'object') return [];
  const {schemaVersion,cards} = frozen as {schemaVersion?:number;cards?:unknown};
  if (schemaVersion !== 1 || !cards || typeof cards !== 'object' || Array.isArray(cards)) return [];
  return Object.entries(cards).flatMap(([id,card]) => card && typeof card === 'object' && (card as EvaluatorCard).id === id ? [card as EvaluatorCard] : []);
}
