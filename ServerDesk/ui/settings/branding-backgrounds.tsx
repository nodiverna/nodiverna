'use client';
// Settings › Branding, the cards Sign-in page and Console (docs/branding.md). Each card names its setting "Background"
// and holds a tile picker: None (the default), the six bundled backgrounds and Own image. The picker is a radiogroup
// with manual activation (arrows move focus, Enter or Space selects), because each selection saves. Own image without
// an upload opens the file picker; with one, the card shows its facts, Replace and Remove. The card shows no
// miniature: the card Preview (branding-preview.tsx) shows the area with the choice. A failed upload says why below
// the limits line. The console upload is measured in the browser (readBackdropMeasure, lib/backdrop.ts); the card
// says while it runs and offers a retry when it fails.
import {useRef,useState,type KeyboardEvent} from 'react';
import {AlertTriangle,Ban,Check,Info,LogIn,PanelsTopLeft,Trash2,Upload,UserRound} from 'lucide-react';
import {backdropMeasureSide,measureBackdrop,type BackdropMeasure} from '@/lib/backdrop';
import type {BrandingBackgroundChoice,BrandingBackgroundSlot,BrandingBackgroundState,BrandingConsoleBackgroundState} from '@/lib/branding';
import {consoleRouteHash} from '@/lib/console-route';
import {useLocale,useT} from '@/ui/base/locale';
import {Btn,Card,Notice,RetryAction} from '@/ui/kit/kit';
import {fitInto} from '@/ui/settings/brand-colors-model';
import {backgroundCustom,backgroundKey,backgroundTiles,brandingFacts,brandingRulesText,tileFocusStep,type BrandingTarget,type MeasurementState} from '@/ui/settings/branding-model';
import {BrandingStateTag} from '@/ui/settings/branding-state-tag';

export type BackgroundActions={
 busy:{key:string;kind:string}|null;
 onChoose:(area:BrandingBackgroundSlot,choice:BrandingBackgroundChoice)=>void;
 onUpload:(target:BrandingTarget)=>void;
 onRemove:(target:BrandingTarget)=>void;
};

/**
 * Measures the console upload in the browser: loads the image from its same-origin URL, draws it scaled to fit
 * backdropMeasureSide (320 px) on the long side, and runs measureBackdrop on the pixels. The server decodes no pixels.
 * `width` and `height` stand in for an SVG without its own size.
 */
export function readBackdropMeasure(url:string,width:number,height:number):Promise<BackdropMeasure>{
 return new Promise((resolve,reject)=>{
  const image=new Image();
  image.decoding='async';
  image.onload=()=>{
   try{
    const size=fitInto(image.naturalWidth||width,image.naturalHeight||height,backdropMeasureSide),canvas=document.createElement('canvas');
    canvas.width=size.width;canvas.height=size.height;
    const context=canvas.getContext('2d',{willReadFrequently:true});
    if(!context)throw new Error('No 2D canvas');
    context.imageSmoothingQuality='high';
    context.drawImage(image,0,0,size.width,size.height);
    resolve(measureBackdrop(context.getImageData(0,0,size.width,size.height).data,size.width,size.height));
   }catch(failure){reject(failure);}
  };
  image.onerror=()=>reject(new Error('The background could not be loaded'));
  image.src=url;
 });
}

/** The measurement feedback of the card Console: a status line while it runs, a warning with a retry after a failure. */
function MeasurementFeedback({state,onRetry}:{state:MeasurementState;onRetry:()=>void}){
 const t=useT();
 if(state?.status==='running')return <p className="sdx-bg-measuring" role="status"><span className="sdx-spin sdx-bg-measuring-spinner" aria-hidden="true"/>{t('branding.console.measuring')}</p>;
 if(state?.status==='failed')return <Notice tone="warning" icon={AlertTriangle} action={<RetryAction onRetry={onRetry}/>}>{t('branding.console.measureFailed')}</Notice>;
 return null;
}

/** The tile picker of an area: one Tab stop on the chosen tile, arrows move focus, Enter or Space (a click) selects. */
function BackgroundPicker({area,state,actions,labelId}:{area:BrandingBackgroundSlot;state:BrandingBackgroundState;actions:BackgroundActions;labelId:string}){
 const t=useT(),tiles=backgroundTiles(state),refs=useRef<(HTMLButtonElement|null)[]>([]);
 const chosen=Math.max(0,tiles.findIndex(tile=>tile.choice===state.choice));
 const [focus,setFocus]=useState<number|null>(null),stop=focus??chosen;
 const busy=actions.busy,ownKey=(choice:BrandingBackgroundChoice)=>backgroundKey(area,choice);
 const blocked=!!busy&&!busy.key.startsWith(`background:${area}:`)&&busy.key!==`portal:${area}`;
 const waitingId=`sdx-bg-waiting-${area}`;
 const keyDown=(event:KeyboardEvent,index:number)=>{
  const next=tileFocusStep(event.key,index,tiles.length);
  if(next===null)return;
  event.preventDefault();setFocus(next);refs.current[next]?.focus();
 };
 const choose=(choice:BrandingBackgroundChoice)=>{
  if(busy)return;
  if(choice===state.choice)return;
  if(choice==='upload'&&!state.upload){actions.onUpload({customerId:null,slot:area});return;}
  actions.onChoose(area,choice);
 };
 return <>
  <div className="sdx-bg-tiles" role="radiogroup" aria-labelledby={labelId}>
   {tiles.map((tile,index)=>{
    const checked=tile.choice===state.choice,loading=busy?.key===ownKey(tile.choice)||tile.choice==='upload'&&busy?.key===`portal:${area}`&&busy.kind==='upload';
    const emptyUpload=tile.choice==='upload'&&!tile.url;
    return <button key={tile.choice} ref={node=>{refs.current[index]=node;}} type="button" role="radio" aria-checked={checked} tabIndex={index===stop?0:-1}
     className={checked?'sdx-bg-tile is-checked':'sdx-bg-tile'} aria-disabled={blocked||undefined} aria-busy={loading||undefined} aria-describedby={blocked?waitingId:undefined}
     aria-label={emptyUpload?`${t(tile.label)}: ${t('branding.uploadBackground')}`:t(tile.label)}
     onClick={()=>choose(tile.choice)} onKeyDown={event=>keyDown(event,index)} onFocus={()=>setFocus(index)}>
     <span className={tile.choice==='none'?'sdx-bg-tile-thumb is-none':emptyUpload?'sdx-bg-tile-thumb is-upload':'sdx-bg-tile-thumb'} aria-hidden="true">
      {tile.url&&<img src={tile.url} alt="" decoding="async" loading="lazy"/>}
      {tile.choice==='none'&&<Ban size={18} aria-hidden/>}
      {emptyUpload&&<><Upload size={16} aria-hidden/><small>{t('branding.uploadBackground')}</small></>}
      {checked&&!loading&&<span className="sdx-bg-tile-check"><Check size={12} aria-hidden/></span>}
      {loading&&<span className="sdx-bg-tile-check is-loading"><span className="sdx-spin sdx-bg-tile-spinner"/></span>}
     </span>
     <span className="sdx-bg-tile-label" aria-hidden="true">{t(tile.label)}</span>
    </button>;
   })}
  </div>
  {blocked&&<p id={waitingId} className="sdx-bg-waiting">{t('branding.busy')}</p>}
 </>;
}

/**
 * One background card: the label and the picker, the limits line, the error of a failed upload, the own-off notice
 * (console), the measurement feedback (console, only while an upload exists), and the facts and actions of a stored
 * upload.
 */
export function BackgroundCard({area,state,actions,ownOff=false,measurement=null,onRetryMeasurement,error}:{area:BrandingBackgroundSlot;state:BrandingBackgroundState|BrandingConsoleBackgroundState;actions:BackgroundActions;ownOff?:boolean;
 measurement?:MeasurementState;onRetryMeasurement?:()=>void;
 /** Why the last upload of this area failed, shown until the next upload or removal. */
 error?:string}){
 const t=useT(),[locale]=useLocale(),upload=state.upload,target:BrandingTarget={customerId:null,slot:area};
 const busy=actions.busy,key=`portal:${area}`,labelId=`sdx-branding-${area}-background`;
 const runs=(kind:string)=>busy?.key===key&&busy.kind===kind;
 const waiting=(kind:string)=>busy&&!runs(kind)?t('branding.busy'):undefined;
 const signin=area==='signin';
 return <Card title={<>{t(signin?'branding.target.signin':'branding.target.console')}<BrandingStateTag custom={backgroundCustom(state)}/></>} description={t(signin?'branding.signin.description':'branding.console.description')}
  icon={signin?LogIn:PanelsTopLeft} iconTone="accent" id={`sdx-branding-${area}`}>
  <div className="sdx-bg-card">
   <h3 id={labelId} className="sdx-brand-label">{t('branding.background.choice')}</h3>
   <BackgroundPicker area={area} state={state} actions={actions} labelId={labelId}/>
   <p className="sdx-brand-rules">{brandingRulesText(area,locale)}</p>
   {error&&<p className="sdx-field-error" role="alert">{error}</p>}
   {!signin&&upload&&<MeasurementFeedback state={measurement} onRetry={onRetryMeasurement??(()=>{})}/>}
   {ownOff&&<Notice tone="info" icon={Info} action={<Btn size="sm" icon={UserRound} onClick={()=>{window.location.hash=consoleRouteHash({view:'account'});}}>{t('branding.console.openAccount')}</Btn>}>{t('branding.console.ownOff')}</Notice>}
   {upload&&<div className="sdx-bg-upload">
    <p className="sdx-branding-facts">{brandingFacts(upload,locale)}</p>
    <div className="sdx-branding-slot-actions">
     <Btn size="sm" icon={Upload} loading={runs('upload')} blocked={waiting('upload')} onClick={()=>actions.onUpload(target)}>{t('branding.replaceBackground')}</Btn>
     <Btn size="sm" variant="ghost" icon={Trash2} loading={runs('remove')} blocked={waiting('remove')} onClick={()=>actions.onRemove(target)}>{t('branding.removeBackground')}</Btn>
    </div>
   </div>}
  </div>
 </Card>;
}
