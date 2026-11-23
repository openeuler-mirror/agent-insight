import assert from 'node:assert/strict';
import test from 'node:test';
import {signControllerPayload} from '../src/lib/storage-core/controller';

test('collector source attestation has a separate body, actor and workspace bound purpose',()=>{
 const body='{"action":"reserve","task_id":"task"}';
 const proof=signControllerPayload('a'.repeat(64),'collector-source/v1','principal','w',body);
 assert.equal(proof,'484c13970b7f2a3d5ba1da9a3b1c1cb0ea7429937b58dac223d93137dbb864fc');
 assert.notEqual(proof,signControllerPayload('a'.repeat(64),'trace-analytics/v1','principal','w',body));
 for(const [actor,workspace,text] of [['other','w',body],['principal','other',body],['principal','w',body+' ']])assert.notEqual(proof,signControllerPayload('a'.repeat(64),'collector-source/v1',actor,workspace,text));
 assert.throws(()=>signControllerPayload('a'.repeat(64),'collector-source/v2','principal','w',body));
});
