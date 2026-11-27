import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {sourceHashes} from './source-hashes.mjs';
test('source evidence records files absent from the tested commit without blocking execution',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-source-hash-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.writeFileSync(path.join(root,'actual.ts'),'committed source');
 assert.deepEqual(sourceHashes(root,['actual.ts','uncommitted-helper.ts']),{'actual.ts':createHash('sha256').update('committed source').digest('hex'),'uncommitted-helper.ts':null});
 assert.throws(()=>sourceHashes(root,['.']),/EISDIR/);
});
