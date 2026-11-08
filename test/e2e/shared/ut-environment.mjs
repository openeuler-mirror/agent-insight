import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
export function boundedUtEnv(root,env,timeoutMs=300000){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<100)throw Error('Invalid UT file timeout');
 const bin=path.join(root,'ut-bin');fs.mkdirSync(bin,{recursive:true,mode:0o700});
 const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
 const guard=path.join(bin,'file-deadline.mjs');
 fs.writeFileSync(guard,`import {writeSync} from 'node:fs';\nif(process.env.NODE_TEST_CONTEXT==='child-v8'){setTimeout(()=>{writeSync(2,'E2E_UT_FILE_TIMEOUT '+JSON.stringify({file:process.argv[1],timeoutMs:${timeoutMs}})+' test file timeout\\n');process.exit(124);},${timeoutMs}).unref();}\n`,{mode:0o600});
 fs.writeFileSync(path.join(bin,'node'),`#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "--test" ]; then exec ${quote(process.execPath)} --import ${quote(pathToFileURL(guard).href)} --test-timeout=${timeoutMs+1000} "$@"; fi\ndone\nexec ${quote(process.execPath)} "$@"\n`,{mode:0o700});
 return {...env,PATH:bin+path.delimiter+env.PATH};
}
