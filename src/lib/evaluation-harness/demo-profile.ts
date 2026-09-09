export const NH_DEMO = process.env.NEXT_PUBLIC_EVALUATION_DEMO === 'true';
export const demoPaths = ['/dashboard','/experiments','/experiments/new','/dataset','/metrics','/version-analysis','/agents','/skills','/trace','/details','/modelconfig/registry'];
export function isDemoPath(path:string){
 return demoPaths.includes(path)||/^\/experiments\/[^/]+(?:\/cases\/[^/]+)?$/.test(path)||/^\/dataset\/versioned-[^/]+$/.test(path);
}
