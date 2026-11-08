import fs from 'node:fs';import {parseArgs} from 'node:util';import {createModelRelay} from './model-relay.mjs';import {loadExecutionConfig,readModelKey} from '../shared/config.mjs';
const {values}=parseArgs({options:{config:{type:'string'},lane:{type:'string',default:'pr'},'key-file':{type:'string'},'token-file':{type:'string'},port:{type:'string',default:'8080'}}});
const config=loadExecutionConfig({file:values.config,profile:values.lane}),key=readModelKey(values['key-file']?{file:values['key-file']}:config.model.key);
const token=fs.readFileSync(values['token-file'],'utf8').trim();if(token.length<32)throw Error('Invalid relay token');
const {server,stats}=createModelRelay({key,token,upstream:config.model.baseUrl,modelName:config.model.modelName,maxRequests:config.model.maxRequests,lifetimeMs:config.timeouts.runMs,requestTimeoutMs:config.timeouts.modelRequestMs});server.listen(Number(values.port),'0.0.0.0',()=>console.log('Model relay ready'));
const stop=()=>server.close(()=>{console.log(JSON.stringify(stats));process.exit(0);});process.once('SIGTERM',stop);process.once('SIGINT',stop);
