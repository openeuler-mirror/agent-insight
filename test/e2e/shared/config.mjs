import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
const defaultFile=fileURLToPath(new URL('../config.json',import.meta.url));
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const keys=(value,allowed)=>{if(!object(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw Error('Unknown or malformed configuration field');};
const fields=['mode','cases','runUt','model','resources','timeouts','storage'];
const modelFields=['baseUrl','modelName','key','options','contextTokens','outputTokens','maxRequests'];
const resourceRanges={cpus:[.25,64],memoryMiB:[1024,131072],workspaceGiB:[1,256],minFreeDiskGiB:[5,1024],hostReserveMiB:[512,65536],pids:[64,4096],appHeapMiB:[128,130560],tmpMiB:[64,8192],stateMiB:[64,8192],prismaMiB:[64,2048],relayMemoryMiB:[64,2048],relayCpus:[.1,8],concurrentRuns:[1,1],retainedWorkspaceLimit:[1,20]};
const timeoutRanges={cleanupGraceMs:[10000,90000],utMs:[1000,10800000],utFileMs:[100,1800000],caseMs:[1000,10800000],runMs:[1000,86400000],modelRequestMs:[100,1800000]};
export function validateKeyReference(ref){keys(ref,['env','fileEnv','file']);if(Object.keys(ref).length!==1)throw Error('Model key requires one credential reference');const [kind,value]=Object.entries(ref)[0];if(kind==='env'&&['ATOMGIT_TOKEN','GITCODE_TOKEN','GITHUB_TOKEN','GH_TOKEN','E2E_WEBHOOK_SECRET'].includes(value))throw Error('Use a dedicated model credential reference');if(typeof value!=='string'||(kind==='file'?!path.isAbsolute(value):! /^[A-Z][A-Z0-9_]*$/.test(value)))throw Error('Invalid credential reference');}
export function modelBaseUrl(value){if(typeof value!=='string')throw Error('Invalid model baseUrl');let url;try{url=new URL(value);}catch{throw Error('Invalid model baseUrl');}if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('Model baseUrl must not contain credentials or query parameters');return url.href.replace(/\/+$/,'');}
function merge(base,override={}){const result={...structuredClone(base),...structuredClone(override)};for(const k of ['model','resources','timeouts','storage'])if(base[k]||override[k])result[k]={...structuredClone(base[k]||{}),...structuredClone(override[k]||{})};return result;}
const bounded=(value,min,max,integer=true)=>{if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max||integer&&!Number.isSafeInteger(value))throw Error('Configuration value outside supported range');};
export function validateExecutionConfig(input){
 keys(input,[...fields,'profile','account']);const c=structuredClone(input);if(!['pr','daily'].includes(c.profile)||!['real','mock'].includes(c.mode)||typeof c.runUt!=='boolean')throw Error('Invalid execution profile or mode');
 if(!Array.isArray(c.cases)||!c.cases.length||new Set(c.cases).size!==c.cases.length||c.cases.some(id=>!/^00[1-6]$/.test(id)))throw Error('Invalid case selection');c.cases.sort();
 keys(c.account,['username']);if(typeof c.account.username!=='string'||!/^test[\w.+-]*@[\w.-]+\.[A-Za-z]{2,}$/.test(c.account.username))throw Error('A dedicated test account email is required');
 keys(c.model,modelFields);c.model.baseUrl=modelBaseUrl(c.model.baseUrl);if(typeof c.model.modelName!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(c.model.modelName))throw Error('Invalid modelName');validateKeyReference(c.model.key);
 if(!object(c.model.options)||JSON.stringify(c.model.options).length>4096||/"(?:__proto__|constructor|apiKey|password|token|authorization|secret)"\s*:/i.test(JSON.stringify(c.model.options)))throw Error('Invalid model options');
 bounded(c.model.contextTokens,1024,2000000);bounded(c.model.outputTokens,1,c.model.contextTokens);bounded(c.model.maxRequests,1,10000);
 keys(c.resources,Object.keys(resourceRanges));for(const [k,[min,max]]of Object.entries(resourceRanges))bounded(c.resources[k],min,max,!['cpus','relayCpus'].includes(k));
 if(c.resources.appHeapMiB>c.resources.memoryMiB-512||c.resources.minFreeDiskGiB<c.resources.workspaceGiB+4)throw Error('Insufficient configured resource headroom');
 keys(c.storage,['stateRootEnv','reportsDir']);if(!/^[A-Z][A-Z0-9_]*$/.test(c.storage.stateRootEnv)||!/^exclude\/core-e2e(?:\/[A-Za-z0-9_-]+)*$/.test(c.storage.reportsDir))throw Error('Storage requires an environment reference and a report directory inside exclude/core-e2e');
 keys(c.timeouts,Object.keys(timeoutRanges));for(const [k,[min,max]]of Object.entries(timeoutRanges))bounded(c.timeouts[k],min,max);
 if(c.timeouts.utFileMs>c.timeouts.utMs||c.timeouts.modelRequestMs>c.timeouts.caseMs||c.timeouts.caseMs>c.timeouts.runMs)throw Error('Inconsistent timeout budgets');return c;
}
export function validateConfig(raw,profile='pr',overrides={}){
 keys(raw,['version','defaults','profiles']);if(raw.version!==1)throw Error('Unsupported config version');keys(raw.defaults,fields);keys(raw.profiles,['pr','daily']);keys(overrides,fields);
 for(const name of ['pr','daily'])keys(raw.profiles[name],[...fields,'account']);
 const profiles=Object.fromEntries(['pr','daily'].map(name=>[name,validateExecutionConfig({...merge(raw.defaults,raw.profiles[name]),profile:name})]));if(profiles.pr.account.username===profiles.daily.account.username)throw Error('PR and daily accounts must be distinct');
 if(!profiles[profile])throw Error('Unknown execution profile');return validateExecutionConfig({...merge(profiles[profile],overrides),profile});
}
export function loadExecutionConfig({file=defaultFile,profile='pr',overrides={},env=process.env}={}){
 if(env.E2E_EXECUTION_CONFIG){let value;try{value=JSON.parse(env.E2E_EXECUTION_CONFIG);}catch{throw Error('Invalid execution config transport');}if(value.profile!==profile)throw Error('Execution profile mismatch');return validateExecutionConfig({...merge(validateExecutionConfig(value),overrides),profile});}
 let raw;try{raw=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw Error('Cannot read valid E2E config JSON');}return validateConfig(raw,profile,overrides);
}
const canonical=value=>Array.isArray(value)?value.map(canonical):object(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
export function configSnapshot(config){const settings=validateExecutionConfig(config);return {hash:createHash('sha256').update(JSON.stringify(canonical(settings))).digest('hex'),settings};}
export function readModelKey(ref,env=process.env){
 validateKeyReference(ref);let value;try{if(ref.env)value=env[ref.env];else{const file=ref.file||env[ref.fileEnv];if(fs.statSync(file).size>65536)throw Error();value=fs.readFileSync(file,'utf8');}}catch{throw Error('Model credential unavailable');}
 if(typeof value!=='string')throw Error('Model credential unavailable');value=value.trim();if(/\s/.test(value)){if(ref.env)throw Error('Invalid model credential');const keys=[...new Set(value.match(/sk-[A-Za-z0-9_-]+/g)||[])];if(keys.length!==1)throw Error('Invalid model credential');value=keys[0];}
 if(!value||/[\s\x00-\x1f\x7f]/.test(value))throw Error('Invalid model credential');return value;
}

export function executionSnapshot(config,env=process.env){
 if(!env.E2E_CONFIG_PROVENANCE)return configSnapshot(config);
 let snapshot;try{snapshot=JSON.parse(env.E2E_CONFIG_PROVENANCE);}catch{throw Error('Invalid config provenance');}
 if(configSnapshot(snapshot.settings).hash!==snapshot.hash)throw Error('Config provenance hash mismatch');return snapshot;
}
export function loadControlConfig({mode,profile,...options}={}){
 const c=loadExecutionConfig({...options,profile:'pr'});
 if(mode&&mode!=='probe'&&mode!==c.mode)throw Error('Control mode differs from config.json; edit the shared trusted configuration');
 if(profile&&profile!=='core-five')throw Error('Unknown control profile');
 if(profile==='core-five'&&JSON.stringify(c.cases)!==JSON.stringify(['001','002','003','004','005']))throw Error('Control cases differ from config.json; remove the legacy profile flag');return c;
}

export function stateRootFor(config,env=process.env){return env.E2E_STATE_ROOT||env[config.storage.stateRootEnv];}
export function runDirectory(project,config,id){return path.join(project,config.storage.reportsDir,id);}
