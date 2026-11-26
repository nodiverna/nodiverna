'use client';
// Shared parts of the inheritance pattern (nodiverna-ui skill §7): permissions,
// tags and alarm rules show entries that come from
// "Alle Geräte" or a parent group. The server decides what is inherited; these
// parts only show the origin and say where the entry can be changed.
import {useId} from 'react';
import {useT} from '@/ui/base/locale';
import type {InheritedReason} from '@/lib/server/identity/inherited-reason';

type InheritedOriginProps={
 /** Origin as the user knows it, for example "Alle Geräte" or "Gerätegruppe: Berlin". */
 label:string;
 /** Opens the origin on its matching tab. Without it, the label is plain text. */
 onOpen?:()=>void;
 /** The line below the origin. Default: changeable only there; null where the entry can be overridden here (alert rules). */
 hint?:string|null;
 /**
  * block (default): the "Inherited" tag, the origin and a visible hint line, for list rows.
  * inline: for chip rows (device header tags). "Inherited" as muted text, the origin, and the hint
  * only for screen readers, as the description of the origin link.
  */
 variant?:'block'|'inline';
 /** Accessible name of the origin link. It must contain the visible label (WCAG 2.5.3). Default: inheritance.openOrigin. */
 openLabel?:string;
};

/** Origin of an inherited, read-only entry: "Inherited", the origin and the hint that it changes only there. */
export function InheritedOrigin({label,onOpen,hint,variant='block',openLabel}:InheritedOriginProps){
 const t=useT();
 const name=openLabel??t('inheritance.openOrigin',{origin:label}),hintText=hint===null?null:hint??t('inheritance.lockedHint');
 if(variant==='inline')return <InlineOrigin label={label} onOpen={onOpen} name={name} hint={hintText}/>;
 return <span className="sdx-inherited-origin">
  <span className="sdx-tag">{t('inheritance.tag')}</span>
  {onOpen?<button type="button" className="sdx-inherited-link" aria-label={name} onClick={onOpen}>{label}</button>:<span className="sdx-inherited-label">{label}</span>}
  {hintText!==null&&<small>{hintText}</small>}
 </span>;
}

/** The inline variant: its own component, so only it needs a generated id for the hint. */
function InlineOrigin({label,onOpen,name,hint}:{label:string;onOpen?:()=>void;name:string;hint:string|null}){
 const t=useT(),hintId=useId();
 return <span className="sdx-inherited-origin sdx-inherited-inline">
  <span className="sdx-inherited-word">{t('inheritance.tag')}</span>
  {onOpen?<button type="button" className="sdx-inherited-link" aria-label={name} aria-describedby={hint?hintId:undefined} onClick={onOpen}>{label}</button>:<span className="sdx-inherited-label">{label}</span>}
  {hint&&<span id={hintId} className="sr-only">{hint}</span>}
 </span>;
}

/** Why an inherited entry gives no rights (lib/server/identity/inherited-reason.ts, shared with lib/server/identity/rbac.ts). */
export type {InheritedReason};
// user-inactive and group-disabled have no text: the subject marker of the row
// ("Benutzer · Deaktiviert", "Benutzergruppe · Deaktiviert") already says why.
const notEffectiveKeys={role:'inheritance.notEffective.role','group-empty':'inheritance.notEffective.groupEmpty','user-customer':'inheritance.notEffective.userCustomer','group-customer':'inheritance.notEffective.groupCustomer'} as const satisfies Partial<Record<InheritedReason,string>>;

/** The reason line of an inherited entry that gives no rights. The server decides the reason; this part only shows it. */
export function InheritedNotEffective({reason}:{reason:InheritedReason}){
 const t=useT(),key=reason in notEffectiveKeys?notEffectiveKeys[reason as keyof typeof notEffectiveKeys]:null;
 return key?<small className="sdx-inherited-reason">{t(key)}</small>:null;
}
