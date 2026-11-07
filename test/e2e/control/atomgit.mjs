import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export class AtomGit {
  constructor({token=process.env.ATOMGIT_TOKEN,baseUrl='https://api.atomgit.com/api/v5',localTest=false}={}){
    if(!token||/[\r\n"\\]/.test(token))throw Error('Invalid ATOMGIT_TOKEN');
    const url=new URL(baseUrl);
    if(baseUrl!=='https://api.atomgit.com/api/v5'&&!(localTest&&url.hostname==='127.0.0.1'&&url.protocol==='http:'))throw Error('Untrusted API endpoint');
    this.token=token;this.baseUrl=baseUrl;
  }
  async request(method,route,body){
    if(!/^\/[a-zA-Z0-9_./?=&%-]+$/.test(route))throw Error('Invalid API route');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-atomgit-'));fs.chmodSync(dir,0o700);
    try{
      const config=path.join(dir,'curl.cfg');fs.writeFileSync(config,`header = "Authorization: Bearer ${this.token}"\n`,{mode:0o600});
      const args=['--silent','--show-error','--max-time','30','-K',config,'--request',method,'--write-out','\n%{http_code}',this.baseUrl+route];
      if(body!==undefined){const payload=path.join(dir,'body.json');fs.writeFileSync(payload,JSON.stringify(body),{mode:0o600});args.push('--header','Content-Type: application/json','--data-binary','@'+payload);}
      const result=await new Promise((resolve,reject)=>{
        const child=spawn('curl',args,{env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe']});let output='';
        child.stdout.on('data',b=>{output+=b;if(output.length>4*1024*1024)child.kill();});child.stderr.resume();child.once('error',reject);child.once('close',code=>resolve({code,output}));
      });
      const split=result.output.lastIndexOf('\n'),status=Number(result.output.slice(split+1));
      if(result.code!==0||status<200||status>=300)throw Error(`AtomGit ${method} failed (HTTP ${status||'unknown'})`);
      return result.output.slice(0,split)?JSON.parse(result.output.slice(0,split)):null;
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  }
  repoPath(repository){if(!/^[\w.-]+\/[\w.-]+$/.test(repository))throw Error('Invalid repository');return '/repos/'+repository;}
  readPull(repository,number){if(!Number.isSafeInteger(number)||number<1)throw Error('Invalid PR number');return this.request('GET',this.repoPath(repository)+'/pulls/'+number);}
  createComment(repository,number,body){if(!Number.isSafeInteger(number)||number<1)throw Error('Invalid PR number');return this.request('POST',this.repoPath(repository)+'/pulls/'+number+'/comments',{body});}
}
