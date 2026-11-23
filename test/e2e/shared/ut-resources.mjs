import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function read(file) {
  try{return fs.readFileSync(file,'utf8').trim();}catch(error){return error.code==='ENOENT'?undefined:null;}
}
function integer(value) {
  if(typeof value!=='string'||!/^\d+$/.test(value))return null;
  const number=Number(value);return Number.isSafeInteger(number)?number:null;
}
const minimum=values=>values.length?Math.min(...values):null;
const delta=(before,after)=>before!==null&&after!==null&&after>=before?after-before:null;
const safeOs=readValue=>{try{const value=readValue();return Number.isSafeInteger(value)&&value>0?value:null;}catch{return null;}};
function counters(file) {
  const text=read(file),values={};
  if(typeof text==='string')for(const line of text.split('\n')){const [key,value]=line.trim().split(/\s+/);values[key]=integer(value);}
  return values;
}
function hierarchy(options) {
  if((options.platform??process.platform)!=='linux')return null;
  const root=path.resolve(options.cgroupRoot??'/sys/fs/cgroup');
  const membership=options.membership===undefined?read('/proc/self/cgroup'):options.membership,mountinfo=options.mountinfo===undefined?read('/proc/self/mountinfo'):options.mountinfo;
  if(typeof membership!=='string'||typeof mountinfo!=='string')throw Error('Resource discovery unavailable');
  const groups=membership.split('\n').map(line=>line.match(/^\d+:([^:]*):(\/.*)$/)).filter(Boolean);
  if(membership.trim()&&!groups.length)throw Error('Invalid resource discovery');
  const decode=value=>value.replace(/\\(040|011|012|134)/g,(_,octal)=>String.fromCharCode(parseInt(octal,8)));
  const inside=(base,target)=>target===base||target.startsWith(base+path.sep);
  const valid=value=>value.startsWith('/')&&!value.split('/').some(part=>part==='..'||part==='.');
  const mounts=mountinfo.split('\n').flatMap(line=>{
    const [left,right]=line.split(' - ');if(!right)return [];
    const columns=left.split(' '),[type,,controllers]=right.split(' ');
    if(!['cgroup','cgroup2'].includes(type)||columns.length<5)return [];
    const mountRoot=decode(columns[3]),mount=path.resolve(decode(columns[4]));
    return valid(mountRoot)&&inside(root,mount)?[{mountRoot,mount,type,controllers:(controllers||'').split(',')}]:[];
  });
  function locate(version,controller) {
    for(const group of groups){
      const member=group[2];if(!valid(member)||(version===2?group[1]!=='':!group[1].split(',').includes(controller)))continue;
      for(const mount of mounts){
        if(mount.type!==(version===2?'cgroup2':'cgroup')||(version===1&&!mount.controllers.includes(controller)))continue;
        const relative=mount.mountRoot==='/'?member.slice(1):member===mount.mountRoot?'':member.startsWith(mount.mountRoot+'/')?member.slice(mount.mountRoot.length+1):null;
        if(relative===null)continue;
        const leaf=path.resolve(mount.mount,relative);if(!inside(mount.mount,leaf))continue;
        const directories=[];for(let current=leaf;;current=path.dirname(current)){directories.push(current);if(current===mount.mount)break;}
        return directories;
      }
    }
    return null;
  }
  const unified=locate(2);
  if(unified)return {version:2,cpu:unified,memory:unified};
  const cpu=locate(1,'cpu'),memory=locate(1,'memory');
  return cpu||memory?{version:1,cpu,memory}:null;
}
function cpuLimit(group) {
  const values=[];let available=0,invalid=false,statDirectory=group?.cpu?.[0];
  for(const directory of group?.cpu||[]){
    let quota,period;
    if(group.version===2){const text=read(path.join(directory,'cpu.max'));if(text===undefined)continue;if(typeof text!=='string'){invalid=true;continue;}[quota,period]=text.split(/\s+/);}
    else{quota=read(path.join(directory,'cpu.cfs_quota_us'));period=read(path.join(directory,'cpu.cfs_period_us'));if(quota===undefined&&period===undefined)continue;}
    const denominator=integer(period),unlimited=quota==='max'||quota==='-1',numerator=integer(quota);
    if(!denominator||(!unlimited&&!numerator)){invalid=true;continue;}available++;
    if(!unlimited){const cores=numerator/denominator;if(!values.length||cores<minimum(values))statDirectory=directory;values.push(cores);}
  }
  return {value:invalid?null:minimum(values),availability:invalid?'unavailable':available?'available':'unsupported',statDirectory};
}
function memoryLimit(group) {
  const values=[];let available=0,invalid=false;
  for(const directory of group?.memory||[]){
    const text=read(path.join(directory,group.version===2?'memory.max':'memory.limit_in_bytes'));
    if(text===undefined)continue;
    if(text==='max'||(group.version===1&&typeof text==='string'&&/^\d+$/.test(text)&&BigInt(text)>BigInt(Number.MAX_SAFE_INTEGER))){available++;continue;}
    const value=integer(text);if(value===null){invalid=true;continue;}available++;values.push(value);
  }
  return {value:invalid?null:minimum(values),availability:invalid?'unavailable':available?'available':'unsupported'};
}

export function startUtResourceMonitor(options={}) {
  const started=performance.now(),parallelism=safeOs(()=>os.availableParallelism()),totalMemory=safeOs(()=>os.totalmem());
  let group=null,discoveryFailed=false;try{group=hierarchy(options);}catch{discoveryFailed=true;}
  let cpu={value:null,availability:'unavailable'},memory={value:null,availability:'unavailable'};
  try{cpu=cpuLimit(group);memory=memoryLimit(group);}catch{}
  const leaf=group?.memory?.[0],version=group?.version??null;
  const currentFile=leaf&&path.join(leaf,version===2?'memory.current':'memory.usage_in_bytes');
  const peakFile=leaf&&path.join(leaf,version===2?'memory.peak':'memory.max_usage_in_bytes');
  const eventFile=version===2&&leaf&&path.join(leaf,'memory.events'),statFile=cpu.statDirectory&&path.join(cpu.statDirectory,'cpu.stat');
  const current=()=>currentFile?integer(read(currentFile)):null,peak=()=>peakFile?integer(read(peakFile)):null;
  const events=()=>eventFile?counters(eventFile):{},stats=()=>statFile?counters(statFile):{};
  const before=current(),peakBefore=peak(),eventsBefore=events(),statsBefore=stats();
  let sampledPeak=before,sampleCount=before===null?0:1,missedSamples=before===null?1:0,result,timer,samplingAvailability='unsupported';
  const sample=()=>{const value=current();if(value===null)missedSamples++;else{sampleCount++;sampledPeak=sampledPeak===null?value:Math.max(sampledPeak,value);}return value;};
  if(currentFile){try{timer=setInterval(()=>{try{sample();}catch{samplingAvailability='unavailable';}},500);timer.unref();samplingAvailability='available';}catch{samplingAvailability='unavailable';}}
  return {finish(){
    if(result)return result;
    if(timer)try{clearInterval(timer);}catch{samplingAvailability='unavailable';}
    const after=sample(),peakAfter=peak(),eventsAfter=events(),statsAfter=stats();
    const eventDelta=name=>delta(eventsBefore[name]??null,eventsAfter[name]??null),statDelta=name=>delta(statsBefore[name]??null,statsAfter[name]??null);
    const oom=eventDelta('oom'),oomKill=eventDelta('oom_kill'),periods=statDelta('nr_periods'),throttled=statDelta('nr_throttled'),throttleTime=statDelta(version===2?'throttled_usec':'throttled_time');
    const currentAvailability=sampleCount?missedSamples?'partial':'available':'unavailable';
    const peakAvailability=peakBefore!==null&&peakAfter!==null?'available':'unavailable';
    const eventsAvailability=eventFile?oom!==null&&oomKill!==null?'available':'unavailable':'unsupported';
    const statAvailability=statFile?periods!==null&&throttled!==null&&throttleTime!==null?'available':'unavailable':'unsupported';
    const availability=!group?discoveryFailed?'unavailable':'unsupported':[cpu.availability,memory.availability,currentAvailability,peakAvailability,...(eventFile?[eventsAvailability]:[]),statAvailability,samplingAvailability].every(value=>value==='available')?'available':'partial';
    result={version:1,cgroupVersion:version,availability,osAvailableParallelism:parallelism,osTotalMemoryBytes:totalMemory,
      cpuLimitAvailability:cpu.availability,cpuQuotaCores:cpu.value,effectiveCpuCores:cpu.availability==='available'?minimum([parallelism,cpu.value].filter(value=>value!==null)):null,
      memoryLimitAvailability:memory.availability,memoryLimitBytes:memory.value,effectiveMemoryLimitBytes:memory.availability==='available'?minimum([totalMemory,memory.value].filter(value=>value!==null)):null,
      samplingAvailability,memoryCurrentAvailability:currentAvailability,memoryCurrentBytesBefore:before,memoryCurrentBytesAfter:after,memorySampleCount:sampleCount,sampledMemoryPeakBytes:sampledPeak,
      kernelMemoryPeakAvailability:peakAvailability,kernelMemoryPeakBytesBefore:peakBefore,kernelMemoryPeakBytesAfter:peakAfter,
      memoryEventsAvailability:eventsAvailability,memoryOomEventsDelta:oom,memoryOomKillEventsDelta:oomKill,
      cpuStatAvailability:statAvailability,cpuNrPeriodsDelta:periods,cpuNrThrottledDelta:throttled,cpuThrottledUsecDelta:throttleTime===null?null:version===1?throttleTime/1000:throttleTime,
      durationMs:Math.round(performance.now()-started)};
    return result;
  }};
}
