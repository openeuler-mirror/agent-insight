import {loadExecutionConfig} from './config.mjs';
import fs from 'node:fs';import path from 'node:path';
export function boundedAppEnv(root,env,resources=loadExecutionConfig({profile:process.env.E2E_LANE||'pr'}).resources){
 if(env.E2E_ISOLATED_CONTAINER!=='1')return env;
 const bin=path.join(root,'app-bin');fs.mkdirSync(bin,{recursive:true,mode:0o700});
 const executable="'"+process.execPath.replaceAll("'","'\\''")+"'";
 fs.writeFileSync(path.join(bin,'node'),`#!/bin/sh\nexport NODE_OPTIONS="$NODE_OPTIONS --max-old-space-size=${resources.appHeapMiB}"\nexec ${executable} --max-old-space-size=${resources.appHeapMiB} "$@"\n`,{mode:0o700});
 return {...env,PATH:bin+path.delimiter+env.PATH,AGENT_INSIGHT_LOG_LEVEL:env.AGENT_INSIGHT_LOG_LEVEL||'info',OPENCODE_LOG_LEVEL:env.OPENCODE_LOG_LEVEL||'info'};
}
