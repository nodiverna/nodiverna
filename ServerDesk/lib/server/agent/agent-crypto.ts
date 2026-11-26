import {HttpError} from '../context';
type PublicKey={kty:'RSA';n:string;e:string};
const base64=(bytes:Uint8Array)=>{let binary='';for(let offset=0;offset<bytes.length;offset+=8192)binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));return btoa(binary);};
export async function sealAgentSecrets(value:Record<string,string>,key:PublicKey|undefined){
 if(!key||key.kty!=='RSA'||!/^[a-zA-Z0-9_-]{342}$/.test(key.n)||key.e!=='AQAB')throw new HttpError('apiError.agent.credentialKeyMissing');
 try{
  const material=crypto.getRandomValues(new Uint8Array(64)),iv=crypto.getRandomValues(new Uint8Array(16));
  const rsa=await crypto.subtle.importKey('jwk',{...key,ext:true},{name:'RSA-OAEP',hash:'SHA-1'},false,['encrypt']);
  const aes=await crypto.subtle.importKey('raw',material.slice(0,32),'AES-CBC',false,['encrypt']);
  const data=new Uint8Array(await crypto.subtle.encrypt({name:'AES-CBC',iv},aes,new TextEncoder().encode(JSON.stringify(value))));
  const macKey=await crypto.subtle.importKey('raw',material.slice(32),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signed=new Uint8Array(iv.length+data.length);signed.set(iv);signed.set(data,iv.length);
  const mac=new Uint8Array(await crypto.subtle.sign('HMAC',macKey,signed));
  const wrapped=new Uint8Array(await crypto.subtle.encrypt('RSA-OAEP',rsa,material));
  material.fill(0);
  return {key:base64(wrapped),iv:base64(iv),data:base64(data),mac:base64(mac)};
 }catch(e){if(e instanceof HttpError)throw e;throw new HttpError('apiError.agent.deviceKeyUnusable');}
}
