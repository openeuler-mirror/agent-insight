import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';
const {sealCredential,openCredential}=await import('./credential-envelope.mjs').catch(()=>({}));
test('deployment credentials persist only authenticated ciphertext bound to their intended name',()=>{
 assert.equal(typeof sealCredential,'function');const key=randomBytes(32),plain=Buffer.from('private-local-fixture-value');const sealed=sealCredential('atomgit-token',plain,key);assert.ok(!JSON.stringify(sealed).includes(plain.toString()));assert.deepEqual(openCredential('atomgit-token',sealed,key),plain);assert.throws(()=>openCredential('webhook-secret',sealed,key));assert.throws(()=>openCredential('atomgit-token',sealed,randomBytes(32)));
});
test('modified or malformed deployment ciphertext is rejected without returning plaintext',()=>{
 assert.equal(typeof sealCredential,'function');const key=randomBytes(32),sealed=sealCredential('atomgit-token',Buffer.from('fixture'),key);
 for(const mutate of [v=>v.ciphertext='AAAA',v=>v.tag=Buffer.alloc(16).toString('base64'),v=>v.version=2,v=>v.iv='bad']){const changed=structuredClone(sealed);mutate(changed);assert.throws(()=>openCredential('atomgit-token',changed,key));}
});
