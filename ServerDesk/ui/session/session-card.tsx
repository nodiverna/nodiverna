'use client';
// The frame of every sign-in, invitation, MFA and session screen: the screen root with the kit scope
// (.sdx-layer, so kit Btn, Field, Notice and Skeleton look as in the console), the glass card, the
// brand row and the heading. The screens put exactly one primary Btn into it.
// The brand row shows the uploaded portal logo (GET /api/branding, docs/branding.md) with the product
// name beside it, else the Nodiverna mark and wordmark. It keeps its height while the request runs, so
// nothing moves when the logo or the mark fades in.
// The same request names the sign-in background: a full-screen cover image behind a light token scrim,
// and the card becomes the opaque panel, so every text keeps its contrast whatever the image shows.
// Without one, or when the request or the image fails, the glow canvas stays.
import {useEffect,useState,type ReactNode} from 'react';
import {ShieldCheck} from 'lucide-react';
import type {BrandingBackgroundView,BrandingPortalView,BrandingPublicView} from '@/lib/branding';
import {BrandMark} from '@/ui/kit/brand-mark';
import {BrandLogo} from '@/ui/kit/brand-logo';
import {productName} from '@/lib/brand';
import '@/ui/session/session.css';

export type SessionBranding={loaded:boolean;portal:BrandingPortalView|null;signinBackground?:BrandingBackgroundView|null};
// One request per page load, shared by every card of the page; a failure counts as no logo and no background.
let publicBranding:Promise<BrandingPublicView|null>|null=null;
export function loadPublicBranding():Promise<BrandingPublicView|null>{
 return publicBranding??=fetch('/api/branding',{credentials:'same-origin',cache:'no-store'})
  .then(response=>response.ok?response.json() as Promise<Partial<BrandingPublicView>>:null)
  .then(answer=>answer?.portal?{portal:answer.portal,signinBackground:answer.signinBackground??null}:null,()=>null);
}
function usePublicBranding():SessionBranding{
 const [state,setState]=useState<SessionBranding>({loaded:false,portal:null,signinBackground:null});
 useEffect(()=>{let live=true;void loadPublicBranding().then(answer=>{if(live)setState({loaded:true,portal:answer?.portal??null,signinBackground:answer?.signinBackground??null});});return ()=>{live=false;};},[]);
 return state;
}

/** The brand row: empty while loading, then the portal logo with the product name, or the Nodiverna mark and wordmark. */
export function SessionBrand({branding}:{branding:SessionBranding}){
 const portal=branding.portal,logo=portal&&(portal.light||portal.dark)?portal:null;
 return <div className="sd-session-brand">{!branding.loaded?null:logo
  ?<div className="sd-session-logo"><BrandLogo light={logo.light} dark={logo.dark} size="session"/><i aria-hidden="true"/><strong>{productName}</strong></div>
  :<><span className="sdx-branding-fade"><BrandMark size={22}/></span><strong className="sdx-branding-fade">{productName}</strong></>}
 </div>;
}

/**
 * The sign-in background: a decorative cover image fixed behind the screen. It fades in once it has loaded; an image
 * that fails to load is dropped, so the glow canvas shows again.
 */
export function SessionBackdrop({background,loaded,failed,onLoad,onError}:{background:BrandingBackgroundView;loaded:boolean;failed:boolean;onLoad:()=>void;onError:()=>void}){
 if(failed)return null;
 return <img className="sd-session-backdrop" src={background.url} alt="" aria-hidden="true" decoding="async" data-loaded={loaded||undefined} onLoad={onLoad} onError={onError}/>;
}

/** The class of the screen root: with a background that has not failed, the image variant (scrim and opaque card). */
export const sessionScreenClass=(background:BrandingBackgroundView|null|undefined,failed:boolean)=>background&&!failed?'sd-session-screen sd-session-screen-image sdx-layer':'sd-session-screen sdx-layer';

export function SessionCard({id,title,className,children}:{id:string;title:ReactNode;className?:string;children:ReactNode}){
 return <SessionScreen branding={usePublicBranding()} id={id} title={title} className={className}>{children}</SessionScreen>;
}

/** The screen for a given branding state (rendered by SessionCard, and by the tests with stubbed state). */
export function SessionScreen({branding,id,title,className,children}:{branding:SessionBranding;id:string;title:ReactNode;className?:string;children:ReactNode}){
 const background=branding.signinBackground??null;
 const [image,setImage]=useState<{url:string;loaded:boolean;failed:boolean}|null>(null);
 const state=image&&background&&image.url===background.url?image:{url:background?.url??'',loaded:false,failed:false};
 return <main className={sessionScreenClass(background,state.failed)}>
  {background&&<SessionBackdrop key={background.url} background={background} loaded={state.loaded} failed={state.failed}
   onLoad={()=>setImage({url:background.url,loaded:true,failed:false})} onError={()=>setImage({url:background.url,loaded:false,failed:true})}/>}
  <section className={className?`sd-session-card ${className}`:'sd-session-card'} aria-labelledby={id}>
   <SessionBrand branding={branding}/>
   <div className="sd-session-heading"><ShieldCheck size={24} aria-hidden/><h1 id={id}>{title}</h1></div>
   {children}
  </section>
 </main>;
}
