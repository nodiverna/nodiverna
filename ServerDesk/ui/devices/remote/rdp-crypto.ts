import {translate} from '@/lib/i18n/translate';
import {documentLocale} from '@/lib/i18n/locale';
// Session keys live only in this iframe's memory. Windows credentials are never
// passed to these helpers or to the portal API.
export const RDP_FRAME_BYTES=16384;
export type RdpCipherFrame={seq:number;data:string};
export function rdpBase64(bytes:Uint8Array){let value='';for(let i=0;i<bytes.length;i+=8192)value+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(value);}
export function rdpUnbase64(value:string,maxBytes=RDP_FRAME_BYTES+16){
 if(typeof value!=='string'||value.length>Math.ceil(maxBytes/3)*4||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw new Error(translate(documentLocale(),'rdp.crypto.invalidBlock'));
 const decoded=Uint8Array.from(atob(value),c=>c.charCodeAt(0));if(decoded.length>maxBytes||rdpBase64(decoded)!==value)throw new Error(translate(documentLocale(),'rdp.crypto.invalidBlock'));return decoded;
}
const bytes=(value:Uint8Array)=>value as Uint8Array<ArrayBuffer>;
function context(id:string,seq:number,direction:'in'|'out'){
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)||!Number.isSafeInteger(seq)||seq<1)throw new Error(translate(documentLocale(),'rdp.crypto.invalidSequence'));
 const iv=new Uint8Array(12);iv.set(new TextEncoder().encode(direction==='in'?'CLNT':'AGNT'));new DataView(iv.buffer).setBigUint64(4,BigInt(seq),false);
 return {name:'AES-GCM',iv,additionalData:new TextEncoder().encode(`ServerDesk:RDP:1:${id}:${direction}:${seq}`),tagLength:128};
}
export async function createRdpKey(id:string,publicKey:JsonWebKey,cryptoApi:Crypto=crypto){
 context(id,1,'in');const raw=cryptoApi.getRandomValues(new Uint8Array(32));
 try{
  const rsa=await cryptoApi.subtle.importKey('jwk',publicKey,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
  const key=await cryptoApi.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['encrypt','decrypt']);
  const payload=new TextEncoder().encode(JSON.stringify({id,key:rdpBase64(raw)}));
  try{return {key,keyEnvelope:rdpBase64(new Uint8Array(await cryptoApi.subtle.encrypt({name:'RSA-OAEP'},rsa,payload)))};}finally{payload.fill(0);}
 }finally{raw.fill(0);}
}
export async function encryptRdpFrame(key:CryptoKey,id:string,seq:number,plain:Uint8Array,cryptoApi:Crypto=crypto):Promise<RdpCipherFrame>{
 if(!plain.length||plain.length>RDP_FRAME_BYTES)throw new Error(translate(documentLocale(),'rdp.crypto.tooLarge'));
 return {seq,data:rdpBase64(new Uint8Array(await cryptoApi.subtle.encrypt(context(id,seq,'in'),key,bytes(plain))))};
}
export async function decryptRdpFrame(key:CryptoKey,id:string,frame:RdpCipherFrame,cryptoApi:Crypto=crypto){
 const cipher=rdpUnbase64(frame.data);if(cipher.length<17)throw new Error(translate(documentLocale(),'rdp.crypto.invalidBlock'));
 return new Uint8Array(await cryptoApi.subtle.decrypt(context(id,frame.seq,'out'),key,bytes(cipher)));
}
