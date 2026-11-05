import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {deriveRootSshTruth,findReferenceInconsistencies} from './builtin-truth.mjs';
const log=fs.readFileSync(new URL('../../../../public/example/messages',import.meta.url),'utf8');
test('root truth is computed only from root authentication failure records, not Kerberos or other users',()=>{
 const truth=deriveRootSshTruth(log);assert.equal(truth.totalLines,2000);assert.equal(truth.rootFailures,351);assert.equal(truth.sources['150.183.249.110'],80);assert.equal(truth.sources['163.27.187.39']||0,0);assert.equal(truth.sources['218.188.2.4']||0,0);assert.equal(truth.sources['195.129.24.210'],15);assert.equal(truth.sourceCount,28);
});
test('reference audit reports actual mismatches instead of forcing correct root analysis to match mixed-event answers',()=>{
 const truth=deriveRootSshTruth(log);assert.deepEqual(findReferenceInconsistencies('150.183.249.110\\t80\\n163.27.187.39\\t23\\n218.188.2.4\\t14',truth),[{source:'163.27.187.39',claimed:23,actual:0},{source:'218.188.2.4',claimed:14,actual:0}]);assert.deepEqual(findReferenceInconsistencies('150.183.249.110\t80\n195.129.24.210\t15',truth),[]);
});
test('the same source may occur in independent categories without merging their counts',()=>{
 const input='A authentication failure; tty=NODEVssh rhost=host.example user=root\nB Authentication failed from host.example: Kerberos\nC authentication failure; rhost=host.example user=guest';const truth=deriveRootSshTruth(input);assert.equal(truth.totalLines,3);assert.equal(truth.rootFailures,1);assert.equal(truth.sources['host.example'],1);
});
