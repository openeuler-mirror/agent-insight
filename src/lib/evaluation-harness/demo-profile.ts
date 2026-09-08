export const NH_DEMO = true;
export const demoPaths = ['/dashboard','/experiments','/experiments/new','/dataset','/metrics','/version-analysis','/agents','/skills','/trace','/details','/modelconfig/registry'];
export function isDemoPath(path:string){
 return demoPaths.includes(path)||/^\/experiments\/[^/]+(?:\/cases\/[^/]+)?$/.test(path)||/^\/dataset\/versioned-[^/]+$/.test(path);
}
