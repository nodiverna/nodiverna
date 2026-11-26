'use client';
// A component card of Hardware → Components: the kind as the title with its icon tile, the main
// value and one detail line. With onOpen the card is interactive (the title button covers the
// card, lifts on hover, presses in) and its tile uses the accent; without it the card is static.
import {ArrowUpRight} from 'lucide-react';
import type {ComponentProps,CSSProperties,ReactNode} from 'react';
import {Card,cx} from '@/ui/kit/kit';

type CardIcon=NonNullable<ComponentProps<typeof Card>['icon']>;
export type ComponentCardProps={icon:CardIcon;
 /** The component kind, for example "Processor"; the card title and the name of its open button. */
 kind:string;value:ReactNode;detail?:ReactNode;
 onOpen?:()=>void;
 /** data-* attributes of the open button. */
 openData?:Readonly<Record<`data-${string}`,string>>;
 /** Set by EntranceList for the entrance. */
 className?:string;style?:CSSProperties};

export function ComponentCard({icon,kind,value,detail,onOpen,openData,className,style}:ComponentCardProps){
 const open=!!onOpen;
 return <Card className={cx('sdx-component-card',className)} style={style} title={kind} icon={icon} iconTone={open?'accent':'neutral'} interactive={open} onOpen={onOpen} openData={openData} actions={open?<ArrowUpRight size={14} aria-hidden className="sdx-component-go"/>:undefined}>
  <div className="sdx-component-body"><strong className="sdx-component-value">{value}</strong>{detail!=null&&detail!==''&&<span className="sdx-component-detail">{detail}</span>}</div>
 </Card>;
}
