import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,chmod,symlink,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test('controller proof binds exact request bytes, principal, workspace and purpose',async()=>{
 const {signControllerPayload}=await import('../src/lib/storage-core/controller');const body='{"action":"cancellation_update","status":"completed"}';
 const key='a'.repeat(64);const signature=signControllerPayload(key,'experiment-cancellation/v1','principal','w',body);
 assert.equal(signature,'d2e14d5bc0653700179888c93846e99fb852325c14c0020b03fde3902cb2309d');
 for(const [purpose,principal,workspace,text] of [['experiment-frozen-assets/v1','principal','w',body],['experiment-cancellation/v1','another','w',body],['experiment-cancellation/v1','principal','other',body],['experiment-cancellation/v1','principal','w',body+' ']])assert.notEqual(signControllerPayload(key,purpose,principal,workspace,text),signature);
});
test('controller secrets must be explicit private regular files',async()=>{
 const {readControllerKey}=await import('../src/lib/storage-core/controller');const root=await mkdtemp(path.join(os.tmpdir(),'core-controller-'));const file=path.join(root,'key');
 try{await writeFile(file,'a'.repeat(64),{mode:0o600});assert.equal(await readControllerKey(file),'a'.repeat(64));await chmod(file,0o644);await assert.rejects(()=>readControllerKey(file));await chmod(file,0o600);await symlink(file,path.join(root,'link'));await assert.rejects(()=>readControllerKey(path.join(root,'link')));await assert.rejects(()=>readControllerKey('relative'));}finally{await rm(root,{recursive:true,force:true});}
});
