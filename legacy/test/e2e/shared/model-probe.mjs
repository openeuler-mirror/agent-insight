export async function probeModelConnection(action,{maxAttempts=3,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),onAttempt=()=>{}}={}){
 const attempts=[];for(let attempt=1;attempt<=maxAttempts;attempt++){const result=await action();const probe=result.probe;attempts.push({attempt,httpStatus:result.status,success:probe.success===true,code:probe.code??null,elapsedMs:probe.elapsedMs??null});await onAttempt(attempts);
 if(probe.success===true)return {...result,attempts};const transient=['server','network','timeout','rate_limit'].includes(probe.code);if(!transient||attempt===maxAttempts){const error=new Error(`Product model probe failed: ${probe.code}; real attempts=${attempt}`);if(transient)error.code='E2E_BLOCKED';throw error;}await wait(1000);
 }throw new Error('No model connection attempt executed');
}
