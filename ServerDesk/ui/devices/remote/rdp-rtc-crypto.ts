import {rdpBase64,rdpUnbase64} from '@/ui/devices/remote/rdp-crypto';

import {translate} from '@/lib/i18n/translate';
import {documentLocale} from '@/lib/i18n/locale';
export const RDP_RTC_SDP_BYTES=32768;
export type RdpRtcSignalKind='offer'|'answer';
function signalContext(id:string,kind:RdpRtcSignalKind){
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)||!['offer','answer'].includes(kind))throw new Error(translate(documentLocale(),'rdp.crypto.invalidSignal'));
 const iv=new Uint8Array(12);iv.set(new TextEncoder().encode(kind==='offer'?'BOFR':'AANS'));new DataView(iv.buffer).setBigUint64(4,BigInt(1),false);
 return {name:'AES-GCM',iv,additionalData:new TextEncoder().encode(`ServerDesk:RDP:RTC:1:${id}:${kind}`),tagLength:128};
}
// Each direction has exactly one immutable SDP per fresh session key. The
// encrypted SDP binds the ICE credentials and DTLS fingerprint to that key.
export async function sealRdpRtcSignal(key:CryptoKey,id:string,kind:RdpRtcSignalKind,sdp:string,cryptoApi:Crypto=crypto){
 const plain=new TextEncoder().encode(sdp);
 if(!plain.length||plain.length>RDP_RTC_SDP_BYTES)throw new Error(translate(documentLocale(),'rdp.crypto.signalTooLarge'));
 try{return rdpBase64(new Uint8Array(await cryptoApi.subtle.encrypt(signalContext(id,kind),key,plain)));}finally{plain.fill(0);}
}
export async function openRdpRtcSignal(key:CryptoKey,id:string,kind:RdpRtcSignalKind,cipher:string,cryptoApi:Crypto=crypto){
 const encrypted=rdpUnbase64(cipher,RDP_RTC_SDP_BYTES+16);if(encrypted.length<17)throw new Error(translate(documentLocale(),'rdp.crypto.invalidSignalData'));
 const plain=new Uint8Array(await cryptoApi.subtle.decrypt(signalContext(id,kind),key,encrypted));
 try{if(plain.length>RDP_RTC_SDP_BYTES)throw new Error(translate(documentLocale(),'rdp.crypto.signalTooLarge'));return new TextDecoder('utf-8',{fatal:true}).decode(plain);}finally{plain.fill(0);encrypted.fill(0);}
}
