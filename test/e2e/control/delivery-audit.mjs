import fs from 'node:fs';import path from 'node:path';
export function appendDelivery(directory,event,{maxBytes=1048576}={}){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<2048)throw Error('Invalid audit quota');
 const text=(value,max)=>value==null?undefined:String(value).slice(0,max);
 const line=JSON.stringify({receivedAt:new Date().toISOString(),method:text(event.method,10),path:text(event.path,64),eventType:text(event.eventType,64),deliveryId:text(event.deliveryId,100),httpStatus:event.httpStatus})+'\n';
 const file=path.join(directory,'deliveries.jsonl');
 if(fs.existsSync(file)&&fs.statSync(file).size+Buffer.byteLength(line)>maxBytes)fs.renameSync(file,file+'.1');
 fs.appendFileSync(file,line,{mode:0o600});
}
