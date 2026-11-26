'use client';
// Settings › Branding, card Colors (docs/branding.md): colors read from the portal logo in the browser, the main color
// chosen from up to three candidates, then a sample of the derived scheme in a light and a dark frame, the readability
// line, and Apply. The card Preview (branding-preview.tsx) shows the same selection on the sign-in page and the
// console, so the page holds the selection (schemeSelection in branding-model.ts) and passes it to both. The sample
// frames take the derived --brand-* values as custom properties on the frame element only (previewProperties);
// ui/settings/branding.css reads them, so no color value is written here. Nothing is saved until Apply; the server
// derives and checks the colors again (lib/brand-scheme.ts). The card ends with what is in use now (the default colors
// or the stored ones) and, with a stored scheme, the way back to the default.
import {useRef,type CSSProperties,type KeyboardEvent} from 'react';
import {Check,ImageUp,RotateCcw,SwatchBook,Upload} from 'lucide-react';
import type {BrandSchemeColors} from '@/lib/branding';
import {useLocale,useT} from '@/ui/base/locale';
import {Btn,Card,Empty,Notice,RetryAction,Skeleton} from '@/ui/kit/kit';
import {fitInto,logoColors} from '@/ui/settings/brand-colors-model';
import {previewProperties,schemeAdjustedLines,schemeContrastText,tileFocusStep,type SchemeSelection} from '@/ui/settings/branding-model';
import {BrandingStateTag} from '@/ui/settings/branding-state-tag';

/** The colors of the portal logo: no logo, reading, failed, or the candidates (possibly none). */
export type LogoColorsState={status:'none'}|{status:'reading'}|{status:'failed'}|{status:'done';candidates:string[]};

/** Draws the logo, scaled to fit 96 × 96, on a canvas and reads its candidate colors. Same-origin URL, so the canvas stays readable. */
export function readLogoColors(url:string):Promise<string[]>{
 return new Promise((resolve,reject)=>{
  const image=new Image();
  image.decoding='async';
  image.onload=()=>{
   try{
    const size=fitInto(image.naturalWidth,image.naturalHeight),canvas=document.createElement('canvas');
    canvas.width=size.width;canvas.height=size.height;
    const context=canvas.getContext('2d',{willReadFrequently:true});
    if(!context)throw new Error('No 2D canvas');
    context.drawImage(image,0,0,size.width,size.height);
    resolve(logoColors(context.getImageData(0,0,size.width,size.height).data));
   }catch(failure){reject(failure);}
  };
  image.onerror=()=>reject(new Error('The logo could not be loaded'));
  image.src=url;
 });
}

type SchemeActions={
 /** The branding request that runs now, if any: Apply and Remove wait with branding.busy. */
 busy:{key:string;kind:string}|null;
 onUploadLight:()=>void;onRetryColors:()=>void;
 onApply:(colors:BrandSchemeColors)=>void;onRemove:()=>void;
};

/** A swatch of a color: the value comes from the logo or the stored scheme, never from the source. */
const swatchStyle=(color:string):CSSProperties=>({background:color});

/** The main color radiogroup: arrows move and select (nothing is saved until Apply), one Tab stop. */
function LeadColors({candidates,selected,onSelect,labelId}:{candidates:readonly string[];selected:number;onSelect:(index:number)=>void;labelId:string}){
 const t=useT(),refs=useRef<(HTMLButtonElement|null)[]>([]);
 const keyDown=(event:KeyboardEvent,index:number)=>{
  const next=tileFocusStep(event.key,index,candidates.length);
  if(next===null)return;
  event.preventDefault();onSelect(next);refs.current[next]?.focus();
 };
 return <div className="sdx-brand-leads" role="radiogroup" aria-labelledby={labelId}>
  {candidates.map((color,index)=><button key={color} ref={node=>{refs.current[index]=node;}} type="button" role="radio" aria-checked={index===selected} tabIndex={index===selected?0:-1}
   className="sdx-brand-lead" aria-label={t('branding.scheme.candidate',{index:index+1,hex:color})} onClick={()=>onSelect(index)} onKeyDown={event=>keyDown(event,index)}>
   <span className="sdx-brand-lead-swatch" style={swatchStyle(color)} aria-hidden="true">{index===selected&&<Check size={14} aria-hidden/>}</span>
   <span className="mono">{color}</span>
  </button>)}
 </div>;
}

/** The derived scheme on a surface of one appearance, under its caption: a primary button, a link, a selected row and an accent glyph. */
function PreviewFrame({mode,style}:{mode:'light'|'dark';style:CSSProperties}){
 const t=useT();
 return <div className="sdx-brand-sample">
  <p>{t(mode==='light'?'branding.slot.light':'branding.slot.dark')}</p>
  <div className={`sdx-branding-frame sdx-branding-frame-${mode} sdx-brand-preview sdx-branding-fade`} style={style} aria-hidden="true">
   <span className="sdx-brand-sample-glyph"><SwatchBook size={18} aria-hidden/></span>
   <span className="sdx-brand-sample-button">{t('branding.scheme.sample.button')}</span>
   <span className="sdx-brand-sample-link">{t('branding.scheme.sample.link')}</span>
   <span className="sdx-brand-sample-selected">{t('branding.scheme.sample.selected')}</span>
  </div>
 </div>;
}

/** The card Colors for the logo colors state, the selection of the page and the stored scheme. */
export function BrandSchemeCard({colors,scheme,selection,onPick,actions}:{colors:LogoColorsState;scheme:BrandSchemeColors|null;selection:SchemeSelection;onPick:(index:number)=>void;actions:SchemeActions}){
 const t=useT(),[locale]=useLocale();
 const {candidates,selected,suggestion,result}=selection,labelId='sdx-branding-scheme-lead';
 const running=(kind:string)=>actions.busy?.kind===kind;
 const waiting=(kind:string)=>actions.busy&&!running(kind)?t('branding.busy'):undefined;
 let body;
 if(colors.status==='none')body=<Empty icon={SwatchBook} title={t('branding.scheme.noLogoTitle')}
  action={<Btn size="sm" icon={Upload} blocked={waiting('upload')} onClick={actions.onUploadLight}>{t('branding.uploadLight')}</Btn>}>{t('branding.scheme.noLogoText')}</Empty>;
 else if(colors.status==='reading')body=<Skeleton variant="facts" rows={2} label={t('branding.scheme.reading')}/>;
 else if(colors.status==='failed')body=<Notice tone="danger" icon={SwatchBook} action={<RetryAction onRetry={actions.onRetryColors}/>}>{t('branding.scheme.readFailed')}</Notice>;
 else if(!candidates.length)body=<Empty icon={SwatchBook} title={t('branding.scheme.noColorTitle')}
  action={<Btn size="sm" icon={ImageUp} blocked={waiting('upload')} onClick={actions.onUploadLight}>{t('branding.replaceLight')}</Btn>}>{t('branding.scheme.noColorText')}</Empty>;
 else body=<>
  <div className="sdx-brand-lead-group">
   <h3 id={labelId} className="sdx-brand-label">{t('branding.scheme.lead')}</h3>
   <LeadColors candidates={candidates} selected={selected} onSelect={onPick} labelId={labelId}/>
  </div>
  {result?.ok&&<>
   <div className="sdx-brand-previews">
    <PreviewFrame key={`light:${suggestion?.primary}`} mode="light" style={previewProperties(result,'light') as CSSProperties}/>
    <PreviewFrame key={`dark:${suggestion?.primary}`} mode="dark" style={previewProperties(result,'dark') as CSSProperties}/>
   </div>
   <div className="sdx-brand-facts">
    <p className="sdx-branding-facts">{schemeContrastText(result,locale)}</p>
    {schemeAdjustedLines(result,locale).map(line=><p key={line}>{line}</p>)}
   </div>
  </>}
 </>;
 const apply=colors.status==='done'&&candidates.length>0&&suggestion&&result?.ok
  ?<Btn size="sm" icon={Check} loading={running('scheme')} blocked={selection.applied?t('branding.scheme.alreadyApplied'):waiting('scheme')} onClick={()=>actions.onApply(suggestion)}>{t('branding.scheme.apply')}</Btn>:null;
 return <Card title={<>{t('branding.colors.title')}<BrandingStateTag custom={!!scheme}/></>} description={t('branding.scheme.description')} icon={SwatchBook} iconTone="accent" id="sdx-branding-scheme">
  {body}
  <div className="sdx-brand-actions">
   <p key={scheme?`${scheme.primary}:${scheme.secondary}`:'default'} className="sdx-brand-applied sdx-branding-fade">
    {scheme&&<span className="sdx-brand-applied-swatches" aria-hidden="true"><span style={swatchStyle(scheme.primary)}/><span style={swatchStyle(scheme.secondary)}/></span>}
    {t(scheme?'branding.scheme.inUseCustom':'branding.scheme.inUseDefault')}
   </p>
   {(apply||scheme)&&<div className="sdx-branding-slot-actions">
    {apply}
    {scheme&&<Btn size="sm" variant="ghost" icon={RotateCcw} loading={running('clearScheme')} blocked={waiting('clearScheme')} onClick={actions.onRemove}>{t('branding.scheme.remove')}</Btn>}
   </div>}
  </div>
 </Card>;
}
