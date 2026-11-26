'use client';
// The kit form parts (nodiverna-ui §3, "Form field"). Field: a label bound to one control, an optional
// hint and an error, each with its own id. The control gets aria-describedby with the hint and the
// error (its own ids are kept) and aria-invalid only while an error is set. Inline puts a switch or
// checkbox and its label on one line, with the hint below. Select: the native select in the kit look,
// blocked with a reason like Btn. Switch: an on/off setting that moves at once and rolls back when its
// change fails. FormActions: the action row of a settings form (extra, Discard, Save).
import {Children,cloneElement,forwardRef,useEffect,useId,useRef,useState,type ChangeEvent,type KeyboardEvent,type ReactElement,type ReactNode,type SelectHTMLAttributes} from 'react';
import {Btn,cx} from '@/ui/kit/kit';
import {Tooltip} from '@/ui/kit/tooltip';
import {useLocale,useT} from '@/ui/base/locale';
import {message} from '@/ui/base/api';

type ControlProps={id?:string;'aria-describedby'?:string;'aria-invalid'?:boolean|'true'|'false'|'grammar'|'spelling'};
const shown=(node:ReactNode)=>node!=null&&node!==false&&node!=='';
const joinIds=(...ids:(string|null|undefined|false)[])=>ids.filter(Boolean).join(' ')||undefined;

export function Field({label,hint,error,inline=false,className,children}:{label:ReactNode;hint?:ReactNode;error?:ReactNode;
 /** A switch or checkbox: the control and the label on one line, the label wraps the control. */
 inline?:boolean;className?:string;
 /** Exactly one control element (input, select, textarea or a component that passes the props on). */
 children:ReactElement<ControlProps>}){
 const base=useId(),control=Children.only(children);
 const id=control.props.id??base+'-control',hintId=base+'-hint',errorId=base+'-error';
 const describedBy=joinIds(control.props['aria-describedby'],shown(hint)&&hintId,shown(error)&&errorId);
 const bound=cloneElement(control,{id,'aria-describedby':describedBy,'aria-invalid':shown(error)?'true':undefined});
 const notes=<>{shown(hint)&&<small id={hintId}>{hint}</small>}{shown(error)&&<p id={errorId} className="sdx-field-error">{error}</p>}</>;
 if(inline)return <div className={cx('sdx-field','sdx-field-inline',className)}><label>{bound}<span>{label}</span></label>{notes}</div>;
 return <div className={cx('sdx-field',className)}><label className="sdx-field-label" htmlFor={id}>{label}</label>{bound}{notes}</div>;
}

// Keys that change or open a native select; a blocked select cancels them (Tab still moves on).
const selectKeys=new Set(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown','Enter',' ','Spacebar']);
export type SelectProps=Omit<SelectHTMLAttributes<HTMLSelectElement>,'size'|'title'>&{
 /** md: the form control (32px; inside a Field it matches the 36px text inputs); sm: the height of small toolbar buttons (30px, Btn size="sm") with 12.5px text. */
 size?:'md'|'sm';
 /** In a Toolbar: room for long option names (up to 320px instead of 168px), the whole filter row at 760px or narrower. */
 wide?:boolean;
 /** As wide as the longest option and never wider than the container, also inside a Field (a short choice in a form card). */
 fit?:boolean;
 /** Why the choice cannot change. The select stays focusable (aria-disabled), keeps the controlled value, shows the reason in a Tooltip and names it as its description. */
 blocked?:string};
/**
 * The kit select: a native <select> in the kit look with the chevron at the right edge. It passes id,
 * aria-describedby and aria-invalid on, so <Field label=…><Select …/></Field> binds the label, hint and
 * error like an input. A blocked select never calls onChange and keeps its controlled value.
 */
export const Select=forwardRef<HTMLSelectElement,SelectProps>(function Select({size='md',wide=false,fit=false,blocked,className,onChange,onKeyDown,onMouseDown,onPointerDown,'aria-describedby':describedBy,children,...rest},ref){
 const reasonId=useId(),[tip,setTip]=useState(false),isBlocked=!!blocked;
 const handlers=isBlocked?{
  onChange:(event:ChangeEvent<HTMLSelectElement>)=>{event.preventDefault();},
  onKeyDown:(event:KeyboardEvent<HTMLSelectElement>)=>{if(selectKeys.has(event.key))event.preventDefault();},
  // The picker does not open; a tap shows the reason, because touch has no hover.
  onMouseDown:(event:{preventDefault:()=>void})=>{event.preventDefault();},
  onPointerDown:(event:{pointerType:string;preventDefault:()=>void})=>{event.preventDefault();if(event.pointerType==='touch')setTip(open=>!open);},
 }:{onChange,onKeyDown,onMouseDown,onPointerDown};
 // The reason's sr-only text sits next to the select, because a select holds only options.
 return <>
  <Tooltip content={blocked??''} open={tip} onOpenChange={setTip}>
   <select ref={ref} className={cx('sdx-select',size==='sm'&&'sdx-select-sm',wide&&'sdx-select-wide',fit&&'sdx-select-fit',isBlocked&&'sdx-select-blocked',className)} aria-disabled={isBlocked||undefined} aria-describedby={joinIds(describedBy,isBlocked&&reasonId)} {...rest} {...handlers}>{children}</select>
  </Tooltip>
  {isBlocked&&<span id={reasonId} className="sr-only">{blocked}</span>}
 </>;
});

/** What a click on a Switch does: the next value, or null while it is blocked or a change is still open. */
export function switchToggle({checked,blocked,busy}:{checked:boolean;blocked:boolean;busy:boolean}):boolean|null{
 return blocked||busy?null:!checked;
}
export type SwitchOutcome={status:'fulfilled';value:unknown}|{status:'rejected';reason:unknown};
/**
 * The end state of a Switch after its onChange promise: resolved to anything but false keeps next;
 * false rolls back without a report (cancelled or already reported); a rejection rolls back and
 * reports the error.
 */
export function switchSettle(previous:boolean,next:boolean,outcome:SwitchOutcome):{checked:boolean;report:boolean;error?:unknown}{
 if(outcome.status==='rejected')return {checked:previous,report:true,error:outcome.reason};
 return outcome.value===false?{checked:previous,report:false}:{checked:next,report:false};
}
type SwitchOverride={value:boolean;open:boolean};
/**
 * An on/off setting: <input type="checkbox" role="switch"> with its label on one line, the hint and a
 * blocked reason below, both named by aria-describedby. A blocked switch stays focusable, shows its real
 * state and ignores clicks. onChange(next) may return a promise: the switch shows next at once
 * (aria-busy while open) and switchSettle decides the end state; a rejection shows toast.error in the
 * console locale (useLocale), not the document language.
 */
export function Switch({label,hint,checked,onChange,blocked,busy=false,id,className}:{label:ReactNode;hint?:ReactNode;checked:boolean;
 onChange:(next:boolean)=>unknown;
 /** Why the setting cannot change now; shown below the label. */
 blocked?:string|null;
 /** A change of this setting runs elsewhere: aria-busy, clicks wait. */
 busy?:boolean;id?:string;className?:string}){
 const base=useId(),hintId=base+'-hint',reasonId=base+'-reason',alive=useRef(true),[locale]=useLocale();
 const [override,setOverride]=useState<SwitchOverride|null>(null),[seen,setSeen]=useState(checked);
 // A new value from the caller ends a kept optimistic value.
 if(seen!==checked){setSeen(checked);if(override&&!override.open)setOverride(null);}
 useEffect(()=>{alive.current=true;return ()=>{alive.current=false;};},[]);
 const shownValue=override?.value??checked,open=!!override?.open,isBlocked=!!blocked;
 const toggle=()=>{
  const next=switchToggle({checked:shownValue,blocked:isBlocked,busy:busy||open});
  if(next===null)return;
  const previous=shownValue,result=onChange(next);
  if(!(result instanceof Promise))return;
  setOverride({value:next,open:true});
  const settle=(outcome:SwitchOutcome)=>{
   if(!alive.current)return;
   const end=switchSettle(previous,next,outcome);
   setOverride(end.checked===checked?null:{value:end.checked,open:false});
   // sonner loads with the first report, so the field module stays free of it (it touches document on load).
   if(end.report)void import('sonner').then(({toast})=>toast.error(message(end.error,locale)));
  };
  result.then(value=>settle({status:'fulfilled',value}),reason=>settle({status:'rejected',reason}));
 };
 return <div className={cx('sdx-switch-field',isBlocked&&'sdx-switch-blocked',className)}>
  <label><input id={id} type="checkbox" role="switch" checked={shownValue} aria-disabled={isBlocked||undefined} aria-busy={busy||open||undefined} aria-describedby={joinIds(shown(hint)&&hintId,isBlocked&&reasonId)} onChange={toggle}/><span>{label}</span></label>
  {shown(hint)&&<small id={hintId}>{hint}</small>}
  {isBlocked&&<small id={reasonId} className="sdx-switch-reason">{blocked}</small>}
 </div>;
}

/**
 * The action row of a form (nodiverna-ui §4 "Settings panel"): extra (leading actions), Discard (ghost,
 * only while dirty) and Save (type="submit"). Save is primary while dirty; not dirty it is a blocked
 * secondary with "No changes"; a given blocked reason (demo mode, invalid input) wins over that; quiet
 * keeps it secondary under a page header that has the primary.
 */
export function FormActions({dirty,onDiscard,saveLabel,loading=false,busy=false,blocked,quiet=false,extra,form}:{dirty:boolean;onDiscard?:()=>void;
 /** Default common.save. */
 saveLabel?:string;
 /** Save shows its spinner. */
 loading?:boolean;
 /** A request of the form runs: Discard is blocked with kit.changeSaving (focusable, with its reason). */
 busy?:boolean;
 blocked?:string;quiet?:boolean;extra?:ReactNode;
 /** The id of the form when the row sits outside it. */
 form?:string}){
 const t=useT(),reason=blocked??(!dirty?t('common.noChanges'):undefined);
 return <div className="sdx-form-actions">
  {extra}
  {dirty&&onDiscard&&<Btn variant="ghost" blocked={busy||loading?t('kit.changeSaving'):undefined} onClick={onDiscard}>{t('common.discard')}</Btn>}
  <Btn type="submit" form={form} className="sdx-form-save" variant={dirty&&!quiet&&!reason?'primary':'secondary'} loading={loading} blocked={reason}>{saveLabel??t('common.save')}</Btn>
 </div>;
}
