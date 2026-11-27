import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startUtResourceMonitor} from './ut-resources.mjs';

function fixture(t, version=2) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ut-resources-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const write=(relative,value)=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,String(value));};
  const options={platform:'linux',cgroupRoot:root,membership:version===2?'0::/tenant/job\n':'3:cpu,cpuacct:/tenant/job\n4:memory:/tenant/job\n',mountinfo:version===2?`29 1 0:26 / ${root} rw - cgroup2 cgroup rw\n`:`29 1 0:26 / ${root}/cpu rw - cgroup cgroup rw,cpu,cpuacct\n30 1 0:27 / ${root}/memory rw - cgroup cgroup rw,memory\n`};
  if(version===2){
    for(const group of ['','tenant','tenant/job']){write(path.join(group,'cpu.max'),group==='tenant'?'200000 100000':'max 100000');write(path.join(group,'memory.max'),group==='tenant'?536870912:'max');}
    write('tenant/job/memory.current',100);write('tenant/job/memory.peak',900);
    write('tenant/job/memory.events','oom 2\noom_kill 1\n');
    write('tenant/cpu.stat','nr_periods 100\nnr_throttled 10\nthrottled_usec 200\n');
  }else{
    for(const group of ['','tenant','tenant/job']){
      write(path.join('cpu',group,'cpu.cfs_quota_us'),group==='tenant'?150000:-1);write(path.join('cpu',group,'cpu.cfs_period_us'),100000);
      write(path.join('memory',group,'memory.limit_in_bytes'),group==='tenant'?268435456:'9223372036854771712');
    }
    write('memory/tenant/job/memory.usage_in_bytes',120);write('memory/tenant/job/memory.max_usage_in_bytes',800);
    write('cpu/tenant/cpu.stat','nr_periods 10\nnr_throttled 2\nthrottled_time 100000\n');
  }
  return {root,write,options};
}

test('v2 respects the tightest visible ancestor quotas without exposing system identities',t=>{
  const f=fixture(t),monitor=startUtResourceMonitor(f.options),result=monitor.finish();
  assert.equal(result.version,1);assert.equal(result.cgroupVersion,2);assert.equal(result.availability,'available');
  assert.equal(result.cpuQuotaCores,2);assert.equal(result.memoryLimitBytes,536870912);
  assert.ok(result.effectiveCpuCores>0&&result.effectiveCpuCores<=2);assert.ok(result.effectiveMemoryLimitBytes>0&&result.effectiveMemoryLimitBytes<=536870912);
  assert.ok(Number.isInteger(result.osAvailableParallelism));assert.ok(result.osTotalMemoryBytes>0);
  assert.ok(!JSON.stringify(result).includes(f.root));assert.doesNotMatch(JSON.stringify(result),/tenant|hostname|pod|127\.0\.0\.1/);
  for(const [key,value] of Object.entries(result))assert.ok(value===null||typeof value==='number'||/Availability$|^availability$/.test(key),key);
});

test('sampling includes start and finish, unrefs and clears its timer, and keeps kernel lifetime peaks separate',t=>{
  const f=fixture(t);let tick,unref=0,cleared=0;
  const timer={unref:()=>unref++};
  t.mock.method(globalThis,'setInterval',(callback,ms)=>{assert.equal(ms,500);tick=callback;return timer;});
  t.mock.method(globalThis,'clearInterval',value=>{assert.equal(value,timer);cleared++;});
  const monitor=startUtResourceMonitor(f.options);assert.equal(unref,1);
  f.write('tenant/job/memory.current',450);tick();
  f.write('tenant/job/memory.current',200);f.write('tenant/job/memory.peak',950);
  f.write('tenant/job/memory.events','oom 5\noom_kill 3\n');f.write('tenant/cpu.stat','nr_periods 140\nnr_throttled 16\nthrottled_usec 1200\n');
  const result=monitor.finish();assert.strictEqual(monitor.finish(),result);assert.equal(cleared,1);
  assert.equal(result.memorySampleCount,3);assert.equal(result.memoryCurrentBytesBefore,100);assert.equal(result.memoryCurrentBytesAfter,200);assert.equal(result.sampledMemoryPeakBytes,450);
  assert.equal(result.kernelMemoryPeakBytesBefore,900);assert.equal(result.kernelMemoryPeakBytesAfter,950);assert.equal(result.kernelMemoryPeakBytesDelta,undefined);
  assert.equal(result.memoryOomEventsDelta,3);assert.equal(result.memoryOomKillEventsDelta,2);
  assert.equal(result.cpuNrPeriodsDelta,40);assert.equal(result.cpuNrThrottledDelta,6);assert.equal(result.cpuThrottledUsecDelta,1000);
});

test('v1 translates quota and nanosecond throttling while unsupported OOM counters remain null',t=>{
  const f=fixture(t,1),monitor=startUtResourceMonitor(f.options);
  f.write('cpu/tenant/cpu.stat','nr_periods 15\nnr_throttled 4\nthrottled_time 350000\n');
  const result=monitor.finish();assert.equal(result.cgroupVersion,1);assert.equal(result.cpuQuotaCores,1.5);assert.equal(result.memoryLimitBytes,268435456);
  assert.equal(result.sampledMemoryPeakBytes,120);assert.equal(result.kernelMemoryPeakBytesBefore,800);assert.equal(result.cpuThrottledUsecDelta,250);
  assert.equal(result.memoryOomEventsDelta,null);assert.equal(result.memoryOomKillEventsDelta,null);assert.equal(result.memoryEventsAvailability,'unsupported');
});

test('mount roots delimit visible ancestry even when membership uses the host hierarchy',t=>{
  const f=fixture(t);f.options.mountinfo=`29 1 0:26 /hidden ${f.root} rw - cgroup2 cgroup rw\n`;f.options.membership='0::/hidden/tenant/job\n';
  assert.equal(startUtResourceMonitor(f.options).finish().cpuQuotaCores,2);
});

test('unsupported platforms and missing controllers return null metrics without a live timer',t=>{
  t.mock.method(globalThis,'setInterval',()=>assert.fail('Unsupported monitoring must not start a timer'));
  for(const options of [{platform:'darwin'},{platform:'linux',cgroupRoot:'/nonexistent-ut-cgroup',membership:'',mountinfo:''}]){
    const result=startUtResourceMonitor(options).finish();assert.equal(result.availability,'unsupported');assert.equal(result.cgroupVersion,null);assert.equal(result.sampledMemoryPeakBytes,null);assert.equal(result.cpuQuotaCores,null);
  }
});

test('malformed files and disappearing counters cannot fail the UT or fabricate zero deltas',t=>{
  const f=fixture(t);f.write('tenant/cpu.max','broken');f.write('tenant/job/memory.current','not-a-number');f.write('tenant/job/memory.events','oom invalid\noom_kill 4\n');
  const monitor=startUtResourceMonitor(f.options);f.write('tenant/cpu.stat','nr_periods 1\nnr_throttled 1\nthrottled_usec 1\n');f.write('tenant/job/memory.events','oom 8\noom_kill 1\n');
  const result=monitor.finish();assert.equal(result.cpuQuotaCores,null);assert.equal(result.cpuLimitAvailability,'unavailable');assert.equal(result.sampledMemoryPeakBytes,null);assert.equal(result.memoryCurrentAvailability,'unavailable');
  assert.equal(result.memoryOomEventsDelta,null);assert.equal(result.memoryOomKillEventsDelta,null);assert.equal(result.cpuNrThrottledDelta,null);assert.equal(result.cpuThrottledUsecDelta,null);
  assert.equal(result.availability,'partial');
});

test('membership traversal and mounts outside the cgroup root are never read',t=>{
  const f=fixture(t);f.options.membership='0::/../tenant/job\n';assert.equal(startUtResourceMonitor(f.options).finish().cgroupVersion,null);
  f.options.membership='0::/tenant/job\n';f.options.mountinfo='29 1 0:26 / /tmp/outside-resource-root rw - cgroup2 cgroup rw\n';
  assert.equal(startUtResourceMonitor(f.options).finish().cgroupVersion,null);
});

test('broken discovery and unavailable timers report incomplete telemetry without throwing',t=>{
  const f=fixture(t);
  for(const membership of [null,'not-cgroup-metadata']){
    const result=startUtResourceMonitor({...f.options,membership,mountinfo:null}).finish();assert.equal(result.availability,'unavailable');assert.equal(result.cgroupVersion,null);
  }
  t.mock.method(globalThis,'setInterval',()=>{throw Error('Timer unavailable');});
  const monitor=startUtResourceMonitor(f.options),result=monitor.finish();assert.equal(result.memorySampleCount,2);assert.equal(result.samplingAvailability,'unavailable');assert.equal(result.availability,'partial');
});
