'use client';
// Text field with a styled suggestion list. Replaces <datalist>, whose list
// is drawn by the browser and does not match the console.
import {useId,useRef,useState,type InputHTMLAttributes} from 'react';
import {Popover} from 'radix-ui';
import {Check,ChevronDown} from 'lucide-react';
import '@/ui/kit/suggest-input.css';

import {useLocale,useT} from '@/ui/base/locale';
type Props=Omit<InputHTMLAttributes<HTMLInputElement>,'value'|'onChange'|'list'>&{value:string;onValueChange:(value:string)=>void;options:string[]};

export default function SuggestInput({value,onValueChange,options,className,onKeyDown,...rest}:Props){
 const t=useT(),[locale]=useLocale();
 const [open,setOpen]=useState(false),[active,setActive]=useState(-1),[typed,setTyped]=useState(false),input=useRef<HTMLInputElement>(null),listId=useId();
 const query=value.trim().toLocaleLowerCase(locale);
 // Show everything until the user types; then filter by what was typed.
 const shown=typed&&query?options.filter(option=>option.toLocaleLowerCase(locale).includes(query)):options;
 const choose=(option:string)=>{onValueChange(option);setOpen(false);setTyped(false);setActive(-1);input.current?.focus();};
 return <Popover.Root open={open&&shown.length>0} onOpenChange={setOpen}>
  <Popover.Anchor asChild>
   <span className={'sd-suggest'+(className?' '+className:'')}>
    <input ref={input} {...rest} value={value} role="combobox" aria-autocomplete="list" aria-expanded={open&&shown.length>0} aria-controls={listId} aria-activedescendant={active>=0?`${listId}-${active}`:undefined}
     onChange={event=>{onValueChange(event.target.value);setTyped(true);setOpen(true);setActive(-1);}}
     onFocus={()=>{setTyped(false);setOpen(true);}}
     onBlur={()=>setTimeout(()=>{if(!document.activeElement?.closest('.sd-suggest-list'))setOpen(false);},0)}
     onKeyDown={event=>{
      onKeyDown?.(event);if(event.defaultPrevented)return;
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setOpen(true);const count=shown.length;if(!count)return;setActive(current=>event.key==='ArrowDown'?(current+1)%count:(current<=0?count-1:current-1));}
      else if(event.key==='Enter'&&open&&active>=0&&shown[active]){event.preventDefault();choose(shown[active]);}
      else if(event.key==='Escape'&&open){event.preventDefault();setOpen(false);}
     }}/>
    <button type="button" tabIndex={-1} className="sd-suggest-toggle" aria-label={t('common.showSuggestions')} onMouseDown={event=>event.preventDefault()} onClick={()=>{setTyped(false);setOpen(current=>!current);input.current?.focus();}}><ChevronDown size={14} aria-hidden/></button>
   </span>
  </Popover.Anchor>
  <Popover.Portal>
   <Popover.Content className="sd-suggest-list" align="start" sideOffset={6} collisionPadding={8} onOpenAutoFocus={event=>event.preventDefault()} onCloseAutoFocus={event=>event.preventDefault()}>
    <ul id={listId} role="listbox">{shown.map((option,index)=><li key={option} id={`${listId}-${index}`} role="option" aria-selected={option===value} className={index===active?'active':undefined} onMouseDown={event=>event.preventDefault()} onMouseEnter={()=>setActive(index)} onClick={()=>choose(option)}>
     <span>{option}</span>{option===value&&<Check size={14} aria-hidden/>}
    </li>)}</ul>
   </Popover.Content>
  </Popover.Portal>
 </Popover.Root>;
}
