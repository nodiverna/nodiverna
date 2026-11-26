'use client';
import {useEffect,useMemo,useState} from 'react';
import {qrMatrix} from '@/ui/session/qr-matrix';
import {portalNow} from '@/ui/base/http';
import {useT} from '@/ui/base/locale';
import '@/ui/session/mfa-qr-code.css';

const quietZone=4,longestTimeout=2147483647;

// The otpauth:// URI of a pending authenticator setup as an inline SVG QR code.
// It is made in the browser; the secret goes to no other service. When the setup
// expires (server time through portalNow), a notice replaces the code.
export default function MfaQrCode({uri,expiresAt}:{uri:string;expiresAt:number}){
 const t=useT();
 const path=useMemo(()=>{
  const matrix=qrMatrix(uri),parts:string[]=[];
  matrix.forEach((row,y)=>row.forEach((dark,x)=>{if(dark)parts.push(`M${x+quietZone} ${y+quietZone}h1v1h-1z`);}));
  return {size:matrix.length+quietZone*2,d:parts.join('')};
 },[uri]);
 // Each timer tick re-reads the clock; an early tick schedules the rest.
 const[tick,setTick]=useState(0),remaining=expiresAt-portalNow();
 useEffect(()=>{
  const left=expiresAt-portalNow();if(left<=0)return;
  const timer=setTimeout(()=>setTick(value=>value+1),Math.min(left,longestTimeout));
  return ()=>clearTimeout(timer);
 },[expiresAt,tick]);
 if(remaining<=0)return <p className="sd-mfa-qr-expired" role="status">{t('mfa.qr.expired')}</p>;
 return <figure className="sd-mfa-qr">
  <svg role="img" aria-label={t('mfa.qr.label')} viewBox={`0 0 ${path.size} ${path.size}`} shapeRendering="crispEdges">
   <rect className="sd-mfa-qr-surface" width={path.size} height={path.size}/>
   <path className="sd-mfa-qr-modules" d={path.d}/>
  </svg>
  <figcaption>{t('mfa.qr.caption')}</figcaption>
 </figure>;
}
