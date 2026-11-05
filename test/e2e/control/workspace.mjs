import {loadExecutionConfig} from '../shared/config.mjs';
import fs from 'node:fs';import path from 'node:path';
export async function createWorkspace(work,run,resources=loadExecutionConfig().resources){
 if(process.platform!=='linux'||process.getuid?.()!==0)throw Error('Bounded disk workspace requires a Linux root controller');
 const retained=fs.readdirSync(path.dirname(work),{withFileTypes:true}).filter(e=>e.isDirectory()&&fs.existsSync(path.join(path.dirname(work),e.name,'workspace.ext4')));if(retained.length>=resources.retainedWorkspaceLimit)throw Error('Retained workspace quota reached; inspect prior recovery images before new runs');
 const space=fs.statfsSync(work);if(space.bavail*space.bsize<resources.minFreeDiskGiB*1024**3)throw Error('Insufficient disk headroom for isolated workspace');
 const disk=path.join(work,'workspace.ext4'),mount=path.join(work,'workspace');let mounted=false;
 fs.writeFileSync(disk,'',{flag:'wx',mode:0o600});fs.mkdirSync(mount,{mode:0o700});
 const release=async({retain=false}={})=>{if(mounted){await run('umount',[mount]);mounted=false;}if(retain)fs.writeFileSync(path.join(work,'workspace-recovery.json'),JSON.stringify({disk,reason:'Report or state export incomplete; retained for offline recovery'}),{mode:0o600});else fs.unlinkSync(disk);fs.rmdirSync(mount);};
 try{
  await run('fallocate',['-l',resources.workspaceGiB+'G',disk]);await run('mkfs.ext4',['-q','-F',disk]);await run('mount',['-o','loop,nodev,nosuid',disk,mount]);mounted=true;fs.rmdirSync(path.join(mount,'lost+found'));fs.chownSync(mount,1000,1000);fs.chmodSync(mount,0o700);
  return {mount,release};
 }catch(error){await release();throw error;}
}
