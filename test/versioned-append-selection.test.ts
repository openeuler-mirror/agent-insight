/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFrozenAppendDataset, frozenAppendCandidates, frozenAppendPayload} from '@/lib/client/versioned-append-cases';
const snapshot={assetVersions:{schemaVersion:1,dataset:{businessId:'dataset',versionId:'version-1',version:1,definition:{name:'Original',cases:[{id:'one',input:'first input',expectedOutput:'original'},{id:'two',input:'same',expectedOutput:'A'},{id:'three',input:'same',expectedOutput:'B'}]}}}};
test('追加候选只来自冻结版本，空白等价但不做语义猜测，重复输入保留明确Case身份',()=>{
 const ds=readFrozenAppendDataset(snapshot)!;
 assert.deepEqual(frozenAppendCandidates(ds,' first\n input ').map(c=>c.id),['one']);
 assert.deepEqual(frozenAppendCandidates(ds,'new question'),[]);
 assert.deepEqual(frozenAppendCandidates(ds,'first input plus extra text'),[]);
 assert.deepEqual(frozenAppendCandidates(ds,'same').map(c=>c.id),['two','three']);
 assert.equal(readFrozenAppendDataset({}),undefined);
 assert.match(readFrozenAppendDataset({assetVersions:{schemaVersion:1,dataset:{}}})!.error!,/固定版本/);
});
test('冻结预期为默认值，本次修改显式记录override，不能绑定版本外Case或不匹配Trace',()=>{
 const ds=readFrozenAppendDataset(snapshot)!;
 const trace={executionId:'trace',taskId:'task',input:'first input',actualOutput:'output',datasetCaseId:'one',referenceOutput:'original'};
 assert.equal(frozenAppendPayload(ds,trace).referenceOverride,undefined);
 assert.equal(frozenAppendPayload(ds,trace).datasetId,'dataset');
 assert.deepEqual(frozenAppendPayload(ds,{...trace,referenceOutput:'manual'}).referenceOverride,{value:'manual',source:'manual'});
 assert.deepEqual(frozenAppendPayload(ds,{...trace,referenceOutput:null}).referenceOverride,{value:null,source:'manual'});
 assert.throws(()=>frozenAppendPayload(ds,{...trace,datasetCaseId:'new-case'}),/固定版本/);
 assert.throws(()=>frozenAppendPayload(ds,{...trace,input:'other input'}),/匹配/);
 assert.throws(()=>frozenAppendPayload(ds,{...trace,datasetCaseId:undefined}),/选择/);
});
