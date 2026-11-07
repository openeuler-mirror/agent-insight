import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const {appendDelivery}=await import('./delivery-audit.mjs').catch(()=>({}));
test('public delivery audit bounds fields and total retained disk usage without logging extra headers',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-delivery-audit-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));assert.equal(typeof appendDelivery,'function');
 for(let i=0;i<200;i++)appendDelivery(dir,{method:'POST',path:'/webhook',eventType:'x'.repeat(10000),deliveryId:'z'.repeat(10000),httpStatus:401,authorization:'private-unused-value'},{maxBytes:2048});
 const files=fs.readdirSync(dir);assert.deepEqual(files.sort(),['deliveries.jsonl','deliveries.jsonl.1']);
 for(const file of files){const p=path.join(dir,file);assert.ok(fs.statSync(p).size<=2048);assert.equal(fs.statSync(p).mode&0o777,0o600);const raw=fs.readFileSync(p,'utf8');assert.ok(!raw.includes('private-unused-value'));for(const line of raw.trim().split('\n')){const r=JSON.parse(line);assert.ok(r.deliveryId.length<=100);assert.ok(r.eventType.length<=64);}}
});
