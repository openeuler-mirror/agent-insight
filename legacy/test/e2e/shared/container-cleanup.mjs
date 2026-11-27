import fs from 'node:fs';import {spawnSync} from 'node:child_process';
export function orphanTargets(rows,preserved){
 const keep=new Set(preserved),targets=new Set(rows.filter(r=>r.parent===1&&!keep.has(r.pid)).map(r=>r.pid));let changed=true;
 while(changed){changed=false;for(const r of rows)if(targets.has(r.parent)&&!targets.has(r.pid)&&!keep.has(r.pid)){targets.add(r.pid);changed=true;}}
 return [...targets];
}
export async function cleanupContainerOrphans(){
 if(process.env.E2E_ISOLATED_CONTAINER!=='1'||process.env.E2E_ATOMGIT_JOB==='1')return {stopped:0};
 if(fs.readFileSync('/proc/1/comm','utf8').trim()!=='docker-init')throw Error('Refusing orphan cleanup outside initialized test container');
 const inspect=()=>{const ps=spawnSync('ps',['-eo','pid=,ppid='],{encoding:'utf8'});if(ps.status!==0)throw Error('Cannot inspect owned container processes');return ps.stdout.trim().split('\n').map(line=>{const [pid,parent]=line.trim().split(/\s+/).map(Number);return {pid,parent};});};
 const targets=orphanTargets(inspect(),[1,process.pid,process.ppid]);
 for(const pid of targets.reverse())try{process.kill(pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}
 if(targets.length)await new Promise(resolve=>setTimeout(resolve,1000));
 for(const pid of targets)try{process.kill(pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
 return {stopped:targets.length};
}
