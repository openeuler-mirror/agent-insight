import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const helper=fileURLToPath(new URL('./actions-process-cleanup.py',import.meta.url));
function runHelper(python,payload){
  return new Promise((resolve,reject)=>{
    const env=Object.fromEntries(['PATH','LANG','LC_ALL','SYSTEMROOT'].filter(name=>process.env[name]!==undefined).map(name=>[name,process.env[name]]));
    const child=spawn(python,['-I',helper],{env,stdio:['pipe','pipe','pipe']});
    let output='',timedOut=false,overflow=false;
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},9000);
    child.stdout.on('data',data=>{if(overflow)return;if(Buffer.byteLength(output)+data.length>1024*1024){overflow=true;child.kill('SIGKILL');return;}output+=data;});child.stderr.resume();child.stdin.on('error',()=>{});
    child.once('error',()=>{clearTimeout(timer);reject(Error('Actions process cleanup helper could not start'));});
    child.once('close',code=>{
      clearTimeout(timer);
      if(timedOut)return reject(Error('Actions process cleanup exceeded its deadline'));
      if(overflow)return reject(Error('Actions process cleanup result exceeded its size limit'));
      let result;try{result=JSON.parse(output);}catch{return reject(Error('Actions process cleanup returned an invalid result'));}
      if(code!==0||result.status!=='PASS')return reject(Error(payload.operation==='check'?'Actions process cleanup capability unavailable':'Actions process cleanup could not verify all owned processes stopped'));
      resolve(result);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export async function createActionsProcessScope({python='python3'}={}){
  if(process.platform!=='linux')throw Error('Actions process cleanup requires Linux');
  const checked=await runHelper(python,{operation:'check'});
  const baseline=checked.baseline;
  if(!Array.isArray(baseline)||!baseline.every(row=>Array.isArray(row)&&row.length===2&&Number.isSafeInteger(row[0])&&row[0]>0&&typeof row[1]==='string'&&/^[0-9]{1,30}$/.test(row[1])))throw Error('Actions process cleanup returned an invalid baseline');
  const token=randomBytes(32).toString('hex');let pending;
  return {
    env:Object.freeze({E2E_ACTIONS_PROCESS_SCOPE:token}),
    cleanup(){return pending||=runHelper(python,{operation:'cleanup',token,baseline}).then(result=>{
      if(!Number.isSafeInteger(result.stopped)||result.stopped<0||result.remaining!==0)throw Error('Actions process cleanup returned an invalid completion');
      return {status:'PASS',stopped:result.stopped,remaining:0};
    });},
  };
}
