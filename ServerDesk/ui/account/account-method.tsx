'use client';
// One sign-in method inside the card "Sign-in & security" of My account (password, passkeys,
// authenticator apps, recovery codes): a level-3 SectionHead with the method's icon tile, its state
// (a StatusPill or a meta line) and its secondary actions, then the method's own content.
import type {ComponentType,ReactNode} from 'react';
import {SectionHead} from '@/ui/kit/kit';

type IconType=ComponentType<{size?:number;className?:string;'aria-hidden'?:boolean}>;

export function MethodSection({id,icon,title,description,state,actions,children}:{id:string;icon:IconType;title:ReactNode;description?:ReactNode;
 /** The state of the method: a StatusPill or a count, shown as the meta line. */
 state?:ReactNode;actions?:ReactNode;children?:ReactNode}){
 const shown=(node:ReactNode)=>node!=null&&node!==false&&node!=='';
 return <section className="sdx-account-method" aria-labelledby={id}>
  <SectionHead level={3} id={id} title={title} icon={icon} iconTone="accent" description={description} meta={state} actions={actions}/>
  {shown(children)&&<div className="sdx-account-method-body">{children}</div>}
 </section>;
}
