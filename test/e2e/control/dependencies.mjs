import fs from 'node:fs';import path from 'node:path';
export function prepareDependencies(source,destination){
 for(const name of ['.prisma','@prisma','prisma'])fs.cpSync(path.join(source,name),path.join(destination,name),{recursive:true,verbatimSymlinks:true});
}
export async function ensureDependencyVolume(docker,image){
 if(!/^sha256:[a-f0-9]{64}$/.test(image))throw Error('Expected immutable image ID');
 const name='agent-insight-e2e-deps-'+image.slice(7,23);
 await docker(['volume','create','--label','agent-insight.e2e.image='+image,name]);
 const script="const fs=require('node:fs');const file='/opt/dependencies/node_modules/.e2e-image';const expected=process.argv[1];if(fs.existsSync(file)&&fs.readFileSync(file,'utf8')!==expected)process.exit(1);if(!fs.existsSync('/opt/dependencies/node_modules/next/package.json'))process.exit(1);fs.writeFileSync(file,expected);";
 await docker(['run','--rm','--network','none','--read-only','--user','0:0','--cap-drop=ALL','--security-opt','no-new-privileges','--memory=256m','--cpus=1','--mount',`type=volume,src=${name},dst=/opt/dependencies/node_modules`,'--entrypoint','node',image,'-e',script,image],300000);
 return name;
}
