import {loadControlConfig} from '../shared/config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Queue } from './queue.mjs';
import { AtomGit } from './atomgit.mjs';
import { createReceiver } from './receiver.mjs';
import {appendDelivery} from './delivery-audit.mjs';

process.umask(0o077);
const {values}=parseArgs({options:{config:{type:'string'},profile:{type:'string'},mode:{type:'string'},repository:{type:'string',default:'gyctl/agent-insight'},'state-dir':{type:'string'},'secret-file':{type:'string'},port:{type:'string',default:'8787'},host:{type:'string',default:'127.0.0.1'}}});
const executionConfig=loadControlConfig({file:values.config,mode:values.mode,profile:values.profile});values.mode ||=executionConfig.mode;
if(!['real','mock','probe'].includes(values.mode))throw Error('Invalid mode');
if(!values['state-dir']||!values['secret-file'])throw Error('--state-dir and --secret-file required');
const port=Number(values.port);if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid port');
const secret=fs.readFileSync(values['secret-file'],'utf8').trim();if(secret.length<32)throw Error('Webhook secret must be at least 32 characters');
const queue=new Queue(path.join(path.resolve(values['state-dir']),'queue.sqlite'));const api=new AtomGit();
const identity=await api.request('GET',api.repoPath(values.repository));if(identity.full_name!==values.repository)throw Error('Repository identity mismatch');
const server=createReceiver({secret,mode:values.mode,executionConfig:values.mode==='probe'?undefined:executionConfig,profile:values.profile,repository:values.repository,queue,readPull:(repo,number)=>api.readPull(repo,number)});
server.on('request',(request,response)=>response.once('finish',()=>{
  const event={receivedAt:new Date().toISOString(),method:request.method,path:request.url?.split('?')[0],eventType:request.headers['x-gitcode-event'],deliveryId:request.headers['x-gitcode-delivery'],httpStatus:response.statusCode};
  try{appendDelivery(path.resolve(values['state-dir']),event);}catch{console.error('Webhook delivery audit unavailable');}
}));
server.listen(port,values.host,()=>console.log(`Webhook receiver: ${values.host}:${port}; repository ${values.repository}; reception only, worker is separate`));
const stop=()=>server.close(()=>{queue.close();process.exit(0);});process.once('SIGINT',stop);process.once('SIGTERM',stop);
