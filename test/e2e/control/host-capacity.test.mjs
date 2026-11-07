import test from 'node:test';import assert from 'node:assert/strict';import {assertMemoryHeadroom} from './host-capacity.mjs';
test('7 GiB test sandbox requires at least 8 GiB host available memory',()=>{
 assert.doesNotThrow(()=>assertMemoryHeadroom('MemAvailable: 8388608 kB\n'));
 assert.throws(()=>assertMemoryHeadroom('MemAvailable: 8388607 kB\n'),/headroom/);
 assert.throws(()=>assertMemoryHeadroom('MemFree: 10000000 kB\n'),/headroom/);
});
