/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { frozenEvaluatorCards } from '@/lib/evaluators/frozen-metadata';

test('历史实验的名称、类目来自冻结卡片，损坏快照不冒充有效定义',()=>{
 const old={id:'custom-stable',name:'old',category:'traj'};
 assert.deepEqual(frozenEvaluatorCards({customEvaluatorSnapshots:{schemaVersion:1,cards:{'custom-stable':old}}}),[old]);
 assert.deepEqual(frozenEvaluatorCards({customEvaluatorSnapshots:{schemaVersion:1,cards:{'custom-stable':{...old,id:'other'}}}}),[]);
 assert.deepEqual(frozenEvaluatorCards({customEvaluatorSnapshots:{schemaVersion:2,cards:{'custom-stable':old}}}),[]);
});
