import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
export function sourceHashes(root,files){
 return Object.fromEntries(files.map(file=>{try{return [file,createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')];}catch(error){if(error.code==='ENOENT')return [file,null];throw error;}}));
}
