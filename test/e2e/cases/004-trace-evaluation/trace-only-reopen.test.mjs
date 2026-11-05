import test from 'node:test';import assert from 'node:assert/strict';
import {reopenTraceExperiment} from './trace-only-reopen.mjs';
test('experiment refresh waits for the protected page to finish restoring identity before unloading it',async()=>{
 let authenticated=false,refreshes=0,readyChecks=0,url;
 const page={goto:async value=>{url=value;authenticated=false;},reload:async()=>{assert.equal(authenticated,true,'refresh interrupted an unfinished login restore');authenticated=false;refreshes++;},getByText:()=>({first:()=>({waitFor:async()=>{await new Promise(r=>setTimeout(r,5));authenticated=true;readyChecks++;}})})};
 await reopenTraceExperiment(page,'http://127.0.0.1:3200',{url:'/experiments/test-id'});
 assert.equal(url,'http://127.0.0.1:3200/experiments/test-id');assert.equal(refreshes,1);assert.equal(readyChecks,2);assert.equal(authenticated,true);
});
