import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
const validate=(name,key)=>{if(!/^[a-z][-a-z0-9]{0,63}$/.test(name)||!Buffer.isBuffer(key)||key.length!==32)throw Error('Invalid credential context');};
export function sealCredential(name,plain,key){
 validate(name,key);const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(name));const ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);
 return {version:1,algorithm:'aes-256-gcm',iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
}
export function openCredential(name,envelope,key){
 validate(name,key);if(envelope?.version!==1||envelope.algorithm!=='aes-256-gcm')throw Error('Invalid credential envelope');
 const decode=(value,length)=>{if(typeof value!=='string'||value.length>1048576||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw Error('Invalid credential encoding');const result=Buffer.from(value,'base64');if(length&&result.length!==length)throw Error('Invalid credential size');return result;};
 const decipher=createDecipheriv('aes-256-gcm',key,decode(envelope.iv,12));decipher.setAAD(Buffer.from(name));decipher.setAuthTag(decode(envelope.tag,16));return Buffer.concat([decipher.update(decode(envelope.ciphertext)),decipher.final()]);
}
