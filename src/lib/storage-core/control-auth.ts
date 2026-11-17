import {createHash} from 'node:crypto';
import {runWithCoreControlCapability,getCoreControlContext as currentContext} from './control-context';
import {compatibilityContext,verifiedCoreLoginBinding} from './compat';
import {controllerHeaders} from './controller';
import {requestCore} from './server';
import {resolveLoginMode} from '@/lib/auth/login-mode';
import {getCoreControlContext} from './control-context';
export async function lookupCoreControlUserByKey(apiKey:string){
 try{const actor=await compatibilityContext(new Request('http://localhost/internal/control-identity',{headers:{'x-witty-api-key':apiKey}}));return {id:actor.principal,username:actor.username,apiKey,externalAccount:null};}catch(error){if((error as any)?.status===401||(error as any)?.status===403)return null;throw error;}
}
export function currentCoreControlUser(username:string){const context=getCoreControlContext();if(!context||context.actor.username!==username)throw Object.assign(new Error('Verified current user required'),{status:403});return {id:context.actor.principal,username,apiKey:context.actor.token,externalAccount:null};}
export async function bootstrapCoreControlUser(username:string,externalAccount?:string){
 const mode=resolveLoginMode();const existing=await verifiedCoreLoginBinding(username);if(existing)return {id:existing.principal,username,apiKey:existing.token,externalAccount:null,_created:false};
 const body=JSON.stringify({action:'login',username,mode,...(externalAccount?{external_account:externalAccount}:{})});
 const headers=await controllerHeaders({principal:'platform-login',workspace:'platform-login'},body,'platform-control-bootstrap/v1');
 const {data}=await requestCore('/v1/compat/platform-control-bootstrap',{method:'POST',body,headers,responseLimit:1024*1024},fetch);
 if(!data.value||typeof data.value!=='object')throw Object.assign(new Error('Invalid control login response'),{status:502});return data.value as {username:string;apiKey:string;externalAccount:string|null;id:string;_created?:boolean};
}

const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
async function capabilityIdentity(capability:Record<string,string>){
 const body=JSON.stringify({action:'identity',capability});const headers=await controllerHeaders({principal:'platform-capability',workspace:'platform-capability'},body,'platform-control-bootstrap/v1');
 const {data}=await requestCore('/v1/compat/platform-control-capability',{method:'POST',body,headers},fetch);const value=data.value as any;
 if(!value||!value.principal||!value.workspace||!value.username)throw Object.assign(new Error('Invalid control capability identity'),{status:502});return value;
}
export async function withCoreControlDevice<T>(request:Request,action:()=>Promise<T>):Promise<T>{
 const match=/^Bearer\s+(dc_[A-Za-z0-9_-]+)$/i.exec(request.headers.get('authorization')||'');if(!match)throw Object.assign(new Error('Device credential required'),{status:401});
 const credentialHash=digest(match[1]);const identity=await capabilityIdentity({type:'device',credential_hash:credentialHash,...(request.headers.get('x-agent-insight-client-id')?{client_id:request.headers.get('x-agent-insight-client-id')!}:{})});
 return runWithCoreControlCapability({token:'control-device',principal:identity.principal,workspace:identity.workspace,username:identity.username},{device:{credentialHash,clientId:identity.client_id}},action);
}
export async function withCoreControlInstall<T>(installToken:string,previousCredential:string|undefined,action:()=>Promise<T>):Promise<T>{
 const tokenHash=digest(installToken);const previousCredentialHash=previousCredential?digest(previousCredential):undefined;const identity=await capabilityIdentity({type:'install',token_hash:tokenHash,...(previousCredentialHash?{previous_credential_hash:previousCredentialHash}:{})});
 return runWithCoreControlCapability({token:'control-install',principal:identity.principal,workspace:identity.workspace,username:identity.username},{install:{tokenHash,...(previousCredentialHash?{previousCredentialHash}:{})}},action);
}
export async function authenticateCoreControlDevice(request:Request):Promise<{clientId:string;user:string}>{
 const existing=currentContext();const token=/^Bearer\s+(dc_[A-Za-z0-9_-]+)$/i.exec(request.headers.get('authorization')||'')?.[1];if(existing?.device&&token&&digest(token)===existing.device.credentialHash){const header=request.headers.get('x-agent-insight-client-id');if(header&&header!==existing.device.clientId)throw Object.assign(new Error('Device client differs'),{status:403});return {clientId:existing.device.clientId,user:existing.actor.username};}
 return withCoreControlDevice(request,async()=>{const context=currentContext()!;return {clientId:context.device!.clientId,user:context.actor.username};});
}
