import {loadExecutionConfig} from '../shared/config.mjs';
export function assertMemoryHeadroom(meminfo,resources=loadExecutionConfig().resources){
 const available=Number(meminfo.match(/^MemAvailable:\s+(\d+) kB$/m)?.[1])*1024;
 if(!Number.isFinite(available)||available<(resources.memoryMiB+resources.hostReserveMiB)*1024**2)throw Error('Insufficient host memory headroom for configured sandbox');
 return available;
}
