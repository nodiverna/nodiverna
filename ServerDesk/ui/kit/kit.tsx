'use client';
// Building blocks of the redesigned console. Every control here follows
// ServerDesk/CLAUDE.md: weighted press states, visible focus, tooltips that
// explain disabled actions and the Aurora accent only through tokens.
import {Children,Fragment,cloneElement,createContext,forwardRef,isValidElement,useContext,useEffect,useId,useLayoutEffect,useRef,useState,type ButtonHTMLAttributes,type CSSProperties,type ComponentType,type ReactElement,type ReactNode,type RefObject} from 'react';
import {Dialog as DialogPrimitive,DropdownMenu} from 'radix-ui';
import {AlertTriangle,ArrowUpCircle,Ban,Check,ChevronRight,Clock3,Copy,FlaskConical,Loader2,Lock,MoreHorizontal,RefreshCw,Search,ShieldCheck,WifiOff,X} from 'lucide-react';
import type {UnavailableReason} from '@/ui/devices/device/device-unavailable';
import type {MessageKey} from '@/lib/i18n/translate';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import type {ConnectionKind} from '@/lib/device-connection';
import {Line,LineChart,ResponsiveContainer} from 'recharts';
import {EMPTY_VALUE,formatDateTime,formatNumber,formatPercent,formatRelative} from '@/lib/i18n/format';
import {useLocale,useT} from '@/ui/base/locale';
import {Tooltip} from '@/ui/kit/tooltip';
import {chartSeries} from '@/ui/kit/chart';
// Import cycle: confirm-dialog.tsx imports Btn, Facts and cx from here. It is safe because both sides use
// each other only at render time; never use an export of confirm-dialog.tsx in top-level code here.
import {ConfirmDialog,ScrimLayerMark,drawerReturnTarget} from '@/ui/kit/confirm-dialog';
import {menuTrigger} from '@/ui/kit/focus-return';
import {useOverflowFocusable,useScrollEdges} from '@/ui/kit/overflow-focusable';

export type IconType=ComponentType<{size?:number;className?:string;'aria-hidden'?:boolean}>;
export const cx=(...names:(string|false|null|undefined)[])=>names.filter(Boolean).join(' ');

type ButtonProps=Omit<ButtonHTMLAttributes<HTMLButtonElement>,'title'>&{
 /** tinted: a flat accent tint (accent-soft fill, strong accent text) for the one focal action of a control group that is not a primary, such as "Ask assistant" in the device header. */
 variant?:'primary'|'secondary'|'ghost'|'danger'|'tinted';
 size?:'sm'|'md';
 icon?:IconType;
 loading?:boolean;
 /** Why the action is unavailable. The button stays focusable (aria-disabled), shows the reason in a Tooltip on hover, focus and tap, and keeps it as its description. */
 blocked?:string;
 /** Tooltip and description of an available button. */
 hint?:string;
 /** A number badge after the label (b.sdx-btn-count, hidden from the name); nothing at 0 or without it. */
 count?:number;
 /** The button's accessible name while the badge shows; it starts with the visible text ("Agent updates, 3 available"). */
 countLabel?:string;
 /** A toggle button (aria-pressed): pressed shows the accent-soft selection look, for example the weekdays of a maintenance window. */
 pressed?:boolean;
};
type ActivationHandlers=Pick<ButtonHTMLAttributes<HTMLButtonElement>,'onClick'|'onKeyDown'|'onKeyUp'|'onPointerDown'|'onMouseDown'>;
const activationKeys=new Set(['Enter',' ','Spacebar']);
/**
 * The activation handlers of a kit button. Available: the caller's own. Blocked: none of the
 * caller's run, and click, Enter and Space are cancelled, so a blocked type="submit" button submits
 * no form, also not through Enter in one of its text fields (implicit submission clicks it). A tap
 * toggles the reason (onTap), because touch has no hover.
 */
export function buttonHandlers(blocked:boolean,handlers:ActivationHandlers,onTap?:()=>void):ActivationHandlers{
 if(!blocked)return handlers;
 return {
  onClick:event=>{event.preventDefault();},
  onKeyDown:event=>{if(activationKeys.has(event.key))event.preventDefault();},
  onKeyUp:event=>{if(activationKeys.has(event.key))event.preventDefault();},
  onPointerDown:event=>{if(event.pointerType==='touch')onTap?.();},
  onMouseDown:undefined,
 };
}
/** The reason or hint as the button's lasting description: hidden from the name, referenced by aria-describedby. */
const Description=({id,text}:{id:string;text:string})=><span id={id} className="sr-only" aria-hidden="true">{text}</span>;

export const Btn=forwardRef<HTMLButtonElement,ButtonProps>(function Btn({variant='secondary',size='md',icon:Icon,loading=false,blocked,hint,count,countLabel,pressed,disabled,className,children,type='button',onClick,onKeyDown,onKeyUp,onPointerDown,onMouseDown,...rest},ref){
 const descriptionId=useId(),[tip,setTip]=useState(false),counted=count!=null&&count>0;
 // loading wins over blocked; disabled and loading keep the native attribute.
 const native=!!disabled||loading,isBlocked=!!blocked&&!loading,text=loading?'':isBlocked?blocked:hint??'';
 return <Tooltip content={text} open={tip} onOpenChange={setTip}>
  <button ref={ref} type={type} className={cx('sdx-btn','sdx-btn-'+variant,size==='sm'&&'sdx-btn-sm',className)} disabled={native} aria-disabled={native||isBlocked||undefined} aria-busy={loading||undefined} aria-pressed={pressed} aria-describedby={text?descriptionId:undefined} {...rest} {...(counted&&countLabel?{'aria-label':countLabel}:{})} {...buttonHandlers(isBlocked,{onClick,onKeyDown,onKeyUp,onPointerDown,onMouseDown},()=>setTip(open=>!open))}>
   {loading?<Loader2 size={size==='sm'?14:15} className="sdx-spin" aria-hidden/>:Icon&&<Icon size={size==='sm'?14:15} aria-hidden/>}
   {(children||counted)&&<span>{children}{counted&&<b className="sdx-btn-count" aria-hidden="true">{count}</b>}</span>}
   {text&&<Description id={descriptionId} text={text}/>}
  </button>
 </Tooltip>;
});

/** The tooltip of an icon button: its label with the shortcut, e.g. "Refresh (R)". */
export const iconButtonTip=(label:string,shortcut:string|undefined,ctrl:string)=>shortcut?`${label} (${shortcut.replace('Control',ctrl)})`:label;
export const IconBtn=forwardRef<HTMLButtonElement,Omit<ButtonProps,'children'|'icon'|'hint'>&{icon:IconType;label:string;shortcut?:string;pressed?:boolean}>(function IconBtn({icon:Icon,label,shortcut,pressed,loading=false,blocked,variant='ghost',className,disabled,type='button',onClick,onKeyDown,onKeyUp,onPointerDown,onMouseDown,...rest},ref){
 const t=useT(),descriptionId=useId(),[tip,setTip]=useState(false);
 const isBlocked=!!blocked&&!loading;
 // The label is the name already; only a blocked reason becomes the description.
 return <Tooltip content={isBlocked?blocked:iconButtonTip(label,shortcut,t('kit.ctrl'))} open={tip} onOpenChange={setTip}>
  <button ref={ref} type={type} className={cx('sdx-icon-btn','sdx-btn-'+variant,className)} aria-label={label} aria-pressed={pressed} aria-keyshortcuts={shortcut} disabled={!!disabled||loading} aria-disabled={isBlocked||undefined} aria-describedby={isBlocked?descriptionId:undefined} {...rest} {...buttonHandlers(isBlocked,{onClick,onKeyDown,onKeyUp,onPointerDown,onMouseDown},()=>setTip(open=>!open))}>
   {loading?<Loader2 size={16} className="sdx-spin" aria-hidden/>:<Icon size={16} aria-hidden/>}
   {isBlocked&&<Description id={descriptionId} text={blocked}/>}
  </button>
 </Tooltip>;
});

export function Kbd({children}:{children:ReactNode}){return <kbd className="sdx-kbd">{children}</kbd>;}

export type StatusKind='online'|'offline'|'waiting'|'maintenance'|'warning'|'critical'|'neutral'|'success'|'accent';
export function StatusPill({kind,children,title,size='md'}:{kind:StatusKind;children:ReactNode;title?:string;
 /** sm: a compact pill in dense rows; lg: the focal state pill that leads a status card (28px, 13px text). */
 size?:'sm'|'md'|'lg'}){
 return <span className={cx('sdx-pill','sdx-pill-'+kind,size!=='md'&&'sdx-pill-'+size)} title={title}><i aria-hidden="true"/>{children}</span>;
}
/**
 * The pill kind of a device connection (deviceConnection().kind), the one mapping for every connection pill:
 * "waiting" (first report pending, registration expired) is neutral, not accent. Job and run pills keep "waiting".
 */
export const connectionPillKind=(kind:ConnectionKind):StatusKind=>kind==='waiting'?'neutral':kind;

/** Linear meter with status tone: the data color (--sd-meter) below the warning level, then amber and red. */
export function Meter({value,label,size='md',warning=80,critical=90}:{value:number|null;label:string;size?:'sm'|'md';warning?:number;critical?:number}){
 const tone=value==null?'unknown':value>=critical?'critical':value>=warning?'warning':'normal';
 return <span className={cx('sdx-meter','sdx-meter-'+tone,size==='sm'&&'sdx-meter-sm')} role={value==null?'img':'meter'} aria-label={label} aria-valuemin={value==null?undefined:0} aria-valuemax={value==null?undefined:100} aria-valuenow={value==null?undefined:Math.round(value)}><span style={{width:`${Math.max(0,Math.min(100,value??0))}%`}}/></span>;
}

export type SegmentItem<T extends string>={id:T;label:string;icon?:IconType;count?:number|string;tone?:StatusKind};
/** Segmented control for switching views inside one area. */
export function Segmented<T extends string>({items,value,onChange,label,size='md',className,iconOnly=false}:{items:ReadonlyArray<SegmentItem<T>>;value:T;onChange:(value:T)=>void;label:string;size?:'sm'|'md';className?:string;iconOnly?:boolean}){
 return <div className={cx('sdx-segmented',size==='sm'&&'sdx-segmented-sm',iconOnly&&'sdx-segmented-icons',className)} role="group" aria-label={label}>
  {items.map(item=><button key={item.id} type="button" aria-pressed={value===item.id} aria-label={iconOnly?item.label:undefined} title={iconOnly?item.label:undefined} className={value===item.id?'active':undefined} onClick={()=>onChange(item.id)}>
   {item.icon&&<item.icon size={14} aria-hidden/>}{!iconOnly&&<span>{item.label}</span>}{item.count!==undefined&&<b className={item.tone?'sdx-count-'+item.tone:undefined}>{item.count}</b>}
  </button>)}
 </div>;
}

export type MenuItemEntry={id:string;label:string;icon?:IconType;onSelect?:()=>void;blocked?:string;danger?:boolean;shortcut?:string;
 /** A short state after the label (span.sdx-tag), for example a paused tab in the "More" menu. */
 tag?:string;
 /** The entry is a link (a menuitem anchor) to this console hash or URL; selecting it follows the link. */
 href?:string};
/** An on/off entry in the switch look (menuitemcheckbox). Toggling keeps the menu open. */
export type MenuCheckboxEntry={id:string;label:string;icon?:IconType;checked:boolean;onCheckedChange:(checked:boolean)=>void;blocked?:string};
export type MenuRadioItem={id:string;value:string;label:string;icon?:IconType;blocked?:string;
 /** The language of the label, for an item named in its own language (English, Deutsch). */
 lang?:string};
/** A one-of-many choice (a group of menuitemradio). Choosing an item closes the menu. */
export type MenuRadioEntry={id:string;label?:string;value:string;onValueChange:(value:string)=>void;items:MenuRadioItem[]};
/** A submenu: a trigger with a chevron; ArrowRight or Enter opens it, ArrowLeft or Esc closes it. */
export type MenuSubEntry={id:string;label:string;icon?:IconType;entries:MenuEntry[]};
/** A non-interactive block at the top of a menu (the account menu head): outside the roving focus, not a menuitem. */
export type MenuHeadEntry={id:string;head:ReactNode};
export type MenuEntry=MenuItemEntry|MenuCheckboxEntry|MenuRadioEntry|MenuSubEntry|MenuHeadEntry|{id:string;separator:true}|{id:string;heading:string};
type SelectEvent=Pick<Event,'preventDefault'>;
/**
 * What selecting a menu entry does. Available: its onSelect runs and the menu closes. Blocked: the
 * select is cancelled (event.preventDefault()), so nothing runs and the menu stays open.
 */
export function menuEntrySelect(entry:{onSelect?:()=>void;blocked?:string}){
 return (event:SelectEvent)=>{
  if(entry.blocked){event.preventDefault();return;}
  entry.onSelect?.();
 };
}
/** Toggling a checkbox entry: the menu stays open (preventDefault); onCheckedChange(!checked) runs unless the entry is blocked. */
export function menuCheckboxSelect(entry:Pick<MenuCheckboxEntry,'checked'|'onCheckedChange'|'blocked'>){
 return (event:SelectEvent)=>{
  event.preventDefault();
  if(!entry.blocked)entry.onCheckedChange(!entry.checked);
 };
}
/** Choosing a radio item: onValueChange(value) and the menu closes; a blocked item changes nothing and keeps the menu open. */
export function menuRadioSelect(entry:Pick<MenuRadioEntry,'onValueChange'>,item:Pick<MenuRadioItem,'value'|'blocked'>){
 return (event:SelectEvent)=>{
  if(item.blocked){event.preventDefault();return;}
  entry.onValueChange(item.value);
 };
}
/** Esc in a submenu closes only the submenu and gives focus back to its trigger (radix would close the whole menu). */
export function submenuEscape(event:SelectEvent,close:()=>void,trigger:{focus:()=>void}|null){
 event.preventDefault();close();trigger?.focus();
}
const hasLabel=(entry:MenuEntry)=>'label' in entry&&typeof entry.label==='string'||'items' in entry;
/** The visible reason of a blocked entry, named by aria-describedby. */
const blockedProps=(reasonId:string|undefined)=>reasonId?{'aria-disabled':'true' as const,'aria-describedby':reasonId}:{};
const entryIcon=(Icon:IconType|undefined)=>Icon?<Icon size={15} aria-hidden/>:<span className="sdx-menu-spacer"/>;
/** One submenu: controlled, so Esc closes only it. */
function MenuSub({entry,base}:{entry:MenuSubEntry;base:string}){
 const [open,setOpen]=useState(false),trigger=useRef<HTMLDivElement>(null);
 return <DropdownMenu.Sub open={open} onOpenChange={setOpen}>
  <DropdownMenu.SubTrigger ref={trigger} className="sdx-menu-item sdx-menu-sub">{entryIcon(entry.icon)}<span>{entry.label}</span><ChevronRight size={15} aria-hidden/></DropdownMenu.SubTrigger>
  <DropdownMenu.Portal><DropdownMenu.SubContent className="sdx-menu" sideOffset={6} alignOffset={-6} collisionPadding={8} loop onEscapeKeyDown={event=>submenuEscape(event,()=>setOpen(false),trigger.current)}>
   {menuEntries(entry.entries,`${base}-${entry.id}`)}
  </DropdownMenu.SubContent></DropdownMenu.Portal>
 </DropdownMenu.Sub>;
}
/** The entries of a menu whose entries are a function: built when the open menu renders its content. */
function LazyMenuEntries({build,base}:{build:()=>MenuEntry[];base:string}){return <>{menuEntries(build(),base)}</>;}
/** The elements of the entries of a menu or submenu (a plain function, so the items sit in the menu's own tree). */
function menuEntries(entries:MenuEntry[],base:string):ReactNode[]{
 return entries.map(entry=>{
  if('separator' in entry)return <DropdownMenu.Separator key={entry.id} className="sdx-menu-separator"/>;
  if('heading' in entry)return <DropdownMenu.Label key={entry.id} className="sdx-menu-heading">{entry.heading}</DropdownMenu.Label>;
  // A plain element: radix moves the roving focus only between items, so the head is never focused.
  if('head' in entry)return <div key={entry.id} className="sdx-menu-head">{entry.head}</div>;
  if('entries' in entry)return <MenuSub key={entry.id} entry={entry} base={base}/>;
  if('items' in entry){
   const labelId=entry.label?`${base}-${entry.id}-label`:undefined;
   return <Fragment key={entry.id}>
    {entry.label&&<DropdownMenu.Label id={labelId} className="sdx-menu-heading">{entry.label}</DropdownMenu.Label>}
    {/* No onValueChange on the group: radix would call it for blocked items too; menuRadioSelect decides. */}
    <DropdownMenu.RadioGroup value={entry.value} aria-labelledby={labelId}>
     {entry.items.map(item=>{
      const reasonId=item.blocked?`${base}-${entry.id}-${item.id}-reason`:undefined;
      return <DropdownMenu.RadioItem key={item.id} value={item.value} lang={item.lang} className={cx('sdx-menu-item',item.blocked&&'sdx-menu-blocked')} {...blockedProps(reasonId)} onSelect={menuRadioSelect(entry,item)}>
       {entryIcon(item.icon)}<span>{item.label}</span><DropdownMenu.ItemIndicator className="sdx-menu-check"><Check size={15} aria-hidden/></DropdownMenu.ItemIndicator>{item.blocked&&<small id={reasonId}>{item.blocked}</small>}
      </DropdownMenu.RadioItem>;
     })}
    </DropdownMenu.RadioGroup>
   </Fragment>;
  }
  const reasonId=entry.blocked?`${base}-${entry.id}-reason`:undefined;
  if('checked' in entry){
   // No onCheckedChange on the radix item: it would run for blocked entries too; menuCheckboxSelect decides.
   return <DropdownMenu.CheckboxItem key={entry.id} checked={entry.checked} className={cx('sdx-menu-item','sdx-menu-switch',entry.icon&&'sdx-menu-switch-icon',entry.blocked&&'sdx-menu-blocked')} {...blockedProps(reasonId)} onSelect={menuCheckboxSelect(entry)}>
    {entry.icon&&<entry.icon size={15} aria-hidden/>}<span>{entry.label}</span><span className="sdx-switch-visual" aria-hidden="true"/>{entry.blocked&&<small id={reasonId}>{entry.blocked}</small>}
   </DropdownMenu.CheckboxItem>;
  }
  const content=<>{entryIcon(entry.icon)}<span>{entry.label}{entry.tag&&<> <span className="sdx-tag">{entry.tag}</span></>}</span>{entry.blocked?<small id={reasonId}>{entry.blocked}</small>:entry.shortcut&&<Kbd>{entry.shortcut}</Kbd>}</>;
  const itemClass=cx('sdx-menu-item',entry.danger&&'sdx-menu-danger',entry.blocked&&'sdx-menu-blocked');
  if(entry.href&&!entry.blocked)return <DropdownMenu.Item key={entry.id} asChild className={itemClass} onSelect={menuEntrySelect(entry)}><a href={entry.href}>{content}</a></DropdownMenu.Item>;
  return <DropdownMenu.Item key={entry.id} className={itemClass} {...blockedProps(reasonId)} onSelect={menuEntrySelect(entry)}>{content}</DropdownMenu.Item>;
 });
}
/**
 * Overflow menu. Unavailable entries stay visible and say why: a blocked entry keeps its place in the
 * roving focus (no radix disabled), is aria-disabled, shows its reason as the visible small line and
 * names it through aria-describedby; selecting it runs nothing and keeps the menu open. Checkbox entries
 * (switch look) keep the menu open, radio items close it, submenus open to the side.
 * entries can be a function: the entries are then built only while the menu is open, so a list of rows with a menu
 * each passes one function that keeps its identity and the rows stay memoized. The caller renders such a menu only
 * when it has entries.
 */
export function Menu({label,entries,trigger,align='end',open,onOpenChange,className}:{label:string;entries:MenuEntry[]|(()=>MenuEntry[]);trigger?:ReactNode;align?:'start'|'end';open?:boolean;onOpenChange?:(open:boolean)=>void;
 /** An extra class of the menu content, for a menu with its own width (the account menu, sdx-account-menu). */
 className?:string}){
 const base=useId();
 if(typeof entries!=='function'&&!entries.some(hasLabel))return null;
 return <DropdownMenu.Root open={open} onOpenChange={onOpenChange} modal={false}>
  <DropdownMenu.Trigger asChild>{trigger??<button type="button" className="sdx-icon-btn sdx-btn-ghost" aria-label={label} title={label}><MoreHorizontal size={16} aria-hidden/></button>}</DropdownMenu.Trigger>
  <DropdownMenu.Portal><DropdownMenu.Content className={cx('sdx-menu',className)} align={align} sideOffset={6} collisionPadding={8} loop>
   {typeof entries==='function'?<LazyMenuEntries build={entries} base={base}/>:menuEntries(entries,base)}
  </DropdownMenu.Content></DropdownMenu.Portal>
 </DropdownMenu.Root>;
}

export type IconTone='accent'|'success'|'warning'|'danger'|'neutral';
/** The anchor of a list row, card head or KPI: a lucide icon in its tone on the tone's soft fill. Decorative, so hidden from screen readers. */
export function IconTile({icon:Icon,tone='accent',size='md'}:{icon:IconType;tone?:IconTone;size?:'sm'|'md'}){
 return <span className={cx('sdx-icon-tile','sdx-icon-tile-'+tone,size==='sm'&&'sdx-icon-tile-sm')} aria-hidden="true"><Icon size={size==='sm'?15:16} aria-hidden/></span>;
}

type CardProps={title?:ReactNode;icon?:IconType;
 /** Renders the head icon as an IconTile in this tone. */
 iconTone?:IconTone;
 /** One line below the title, before meta. */
 description?:ReactNode;
 meta?:ReactNode;actions?:ReactNode;children:ReactNode;className?:string;style?:CSSProperties;flush?:boolean;id?:string;
 /** The whole card opens something: the title (or openLabel without a title) becomes a button that covers the card; actions stay clickable above it. */
 interactive?:boolean;onOpen?:()=>void;openLabel?:string;
 /** data-* attributes of that open button, for example the id of the item it opens. */
 openData?:Readonly<Record<`data-${string}`,string>>;
 /** The heading is a programmatic focus target (tabIndex -1), for a link that jumps to this card. */
 focusTarget?:boolean;
 /** The heading level: 2 (default), or 3 for a card inside a titled group (the offers of the device Extensions area). */
 level?:2|3};
/** A section: the head through SectionHead (class sdx-card-head kept for the card CSS), then the body. */
export function Card({title,icon,iconTone,description,meta,actions,children,className,style,flush=false,id,interactive=false,onOpen,openLabel,openData,focusTarget,level}:CardProps){
 const heading=title&&(interactive?<button type="button" className="sdx-card-hit" onClick={onOpen} {...openData}>{title}</button>:title);
 return <section className={cx('sdx-card',flush&&'sdx-card-flush',interactive&&'sdx-card-interactive sdx-lift',className)} style={style} aria-labelledby={title&&id?id:undefined}>
  {interactive&&!title&&<button type="button" className="sdx-card-hit sdx-card-hit-bare" onClick={onOpen} {...openData}><span className="sr-only">{openLabel}</span></button>}
  {(title||actions)&&<SectionHead title={heading} icon={title?icon:undefined} iconTone={iconTone} description={description} meta={meta} actions={actions} id={id} focusTarget={focusTarget} level={level} className="sdx-card-head" actionsClassName="sdx-card-actions"/>}
  {children}
 </section>;
}

type SectionHeadProps={title:ReactNode;
 /** A control at the leading edge, before the title (a back IconBtn): it does not shrink and sits centred on the first text line. */
 leading?:ReactNode;
 /** The title is only the accessible heading (sr-only, id kept) and the icon is not rendered: for a panel whose name the subarea tab already shows. */
 hideTitle?:boolean;
 /** One line that says what the section holds. */
 description?:ReactNode;
 /** Freshness or a count, in muted 12px. */
 meta?:ReactNode;
 icon?:IconType;
 /** Shows the icon as an IconTile in this tone; without it the icon is plain and muted. */
 iconTone?:IconTone;
 /** Secondary actions, before primary. */
 actions?:ReactNode;primary?:ReactNode;level?:2|3;id?:string;className?:string;
 /** Extra class of the actions box (Card keeps sdx-card-actions). */
 actionsClassName?:string;
 /** The heading is a programmatic focus target (tabIndex -1). */
 focusTarget?:boolean};
/**
 * The head of a section or card: the heading (h2 or h3) with its icon, the description, the meta
 * line, and at the end the actions followed by the primary action. At 760px or narrower the actions
 * wrap below the title. A leading control (a back IconBtn) comes first and stays on the first line.
 */
export function SectionHead({title,leading,hideTitle=false,description,meta,icon:Icon,iconTone,actions,primary,level=2,id,className,actionsClassName,focusTarget}:SectionHeadProps){
 const Heading=level===3?'h3':'h2',icon=!hideTitle&&Icon&&(iconTone?<IconTile icon={Icon} tone={iconTone} size="sm"/>:<Icon size={15} aria-hidden/>);
 const shown=(node:ReactNode)=>node!=null&&node!==false&&node!=='';
 return <header className={cx('sdx-section-head',className)}>
  {shown(leading)&&<div className="sdx-section-head-lead">{leading}</div>}
  <div className="sdx-section-head-text">{shown(title)&&<Heading id={id} className={hideTitle?'sr-only':undefined} tabIndex={focusTarget?-1:undefined}>{icon}{title}</Heading>}{shown(description)&&<p>{description}</p>}{shown(meta)&&<p className="sdx-section-head-meta">{meta}</p>}</div>
  {(shown(actions)||shown(primary))&&<div className={cx('sdx-section-head-actions',actionsClassName)}>{actions}{primary}</div>}
 </header>;
}

export type FactItem={label:ReactNode;value:ReactNode;
 /** Shows the value in the mono face (IPs, versions, paths, numbers). */
 mono?:boolean;
 /** A muted line after the value. */
 hint?:ReactNode;
 /** A stable key; the index otherwise. */
 id?:string};
/**
 * Label/value pairs: dl.sdx-facts with one div > dt + dd per item. The label sits beside the
 * value and, at 760px or narrower, above it; 2 and 3 columns fall back to one there. stacked
 * puts the label above the value at every width, so a value with a pill and a button keeps
 * the full column width.
 */
export function Facts({items,columns=1,stacked=false,className}:{items:readonly FactItem[];columns?:1|2|3;stacked?:boolean;className?:string}){
 return <dl className={cx('sdx-facts',columns>1&&'sdx-facts-'+columns,stacked&&'sdx-facts-stacked',className)}>
  {items.map((item,index)=><div key={item.id??index}><dt>{item.label}</dt><dd>{item.mono?<span className="mono">{item.value}</span>:item.value}{item.hint!=null&&item.hint!==false&&item.hint!==''&&<small>{item.hint}</small>}</dd></div>)}
 </dl>;
}

export type KpiTone='accent'|'success'|'warning'|'critical'|'neutral';
const kpiTiles:Record<KpiTone,IconTone>={accent:'accent',success:'success',warning:'warning',critical:'danger',neutral:'neutral'};
type KpiBase={label:string;
 /** A number is formatted in the console language; a string shows as given (for example "12 GiB" or an uptime); null shows a dash. */
 value:number|string|null;
 /** Small text after the value, for example "%" or "free". */
 unit?:string;digits?:number;
 /** The change or freshness below the value. */
 detail?:ReactNode;detailTitle?:string;labelTitle?:string;
 icon?:IconType;
 /** Tile tone; warning and critical also color the value. */
 tone?:KpiTone;
 /** A Meter or Sparkline below the value. */
 visual?:ReactNode;className?:string;style?:CSSProperties;
 /**
  * A live measurement (CPU, RAM, a rate): KpiRow keeps the tile with "—" when the value is missing, so a
  * stale or offline reading shows as such (nodiverna-ui §8). Other tiles without a value are left out.
  */
 live?:boolean;
 /** The count this value is compared with (for example all adapters). KpiRow leaves the tile out when the value equals it: "4 of 4" says nothing. */
 total?:number};
export type KpiProps=KpiBase&{
 /** Tooltip. With onSelect it says what selecting does (for example "Show problems") and is also screen reader text. */
 hint?:string}&({onSelect?:undefined;action?:ReactNode;pressed?:undefined}|{onSelect:()=>void;action?:never;
 /** A filter tile that is on: aria-pressed and the selection look (accent-soft fill and a leading accent bar). Without it the button has no aria-pressed. */
 pressed?:boolean});
/**
 * A headline number: label with its icon tile, the value in large tabular
 * figures and the detail below it. Static (article with an aria-label) or, with
 * onSelect, a button that lifts like an interactive card.
 */
export function Kpi(props:KpiProps){
 const t=useT(),[locale]=useLocale();
 const {label,value,unit,digits=0,detail,detailTitle,labelTitle,icon,tone='accent',visual,className,style}=props;
 // live and total only steer KpiRow.
 const shown=value===null?EMPTY_VALUE:typeof value==='number'?formatNumber(locale,value,{maximumFractionDigits:digits}):value;
 const interactive=!!props.onSelect,Box=interactive?'span':'div';
 const classes=cx('sdx-kpi',(tone==='warning'||tone==='critical')&&'sdx-kpi-'+tone,className);
 const heading=interactive?<span className="sdx-kpi-label" title={labelTitle??label}>{label}</span>:<h3 className="sdx-kpi-label" title={labelTitle??label}>{label}</h3>;
 const body=<>
  <Box className="sdx-kpi-head">{icon&&<IconTile icon={icon} tone={kpiTiles[tone]} size="sm"/>}{heading}{!interactive&&props.action}</Box>
  <Box className="sdx-kpi-body">
   {visual&&<Box className="sdx-kpi-visual">{visual}</Box>}
   <Box className="sdx-kpi-text"><span className="sdx-kpi-value">{shown}{unit&&value!==null&&<small className="sdx-kpi-unit">{unit}</small>}</span>{detail!=null&&detail!==''&&<span className="sdx-kpi-detail" title={detailTitle??(typeof detail==='string'?detail:undefined)}>{detail}</span>}</Box>
  </Box>
 </>;
 if(props.onSelect)return <button type="button" className={cx(classes,'sdx-kpi-button','sdx-lift',props.pressed&&'sdx-kpi-pressed')} style={style} title={props.hint} aria-pressed={props.pressed} onClick={props.onSelect}>{body}{props.hint&&<span className="sr-only">{props.hint}</span>}</button>;
 return <article className={classes} style={style} title={props.hint} aria-label={t('kpi.label',{label,value:value===null?t('kit.noValue'):unit?`${shown} ${unit}`:shown})}>{body}</article>;
}

/**
 * Whether KpiRow shows a Kpi: a live tile always (it shows "—" when its value is missing); any other tile
 * only with a value ("—" counts as none) that is not equal to its total.
 */
export function kpiShown({value,live,total}:Pick<KpiProps,'value'|'live'|'total'>):boolean{
 if(live)return true;
 if(value===null||value===undefined||value===EMPTY_VALUE)return false;
 return total===undefined||value!==total;
}
/**
 * A row of KPI tiles: 4 in one row on a desktop; at 760px or narrower one scrolling line of compact tiles (label and
 * value on one line, --sd-kpi-h-compact high, no detail and no visual; a cut edge fades like a tab bar's). With entranceId the tiles rise in once
 * per page load. It shows only numbers that say something: a Kpi without a value or with a value equal to its
 * total is left out (kpiShown), and a row with fewer than two tiles renders nothing.
 */
export function KpiRow({label,children,entranceId,className}:{label:string;children:ReactNode;entranceId?:string;className?:string}){
 const tiles=Children.toArray(children).filter(child=>!isValidElement(child)||child.type!==Kpi||kpiShown(child.props as KpiProps));
 // At 760px or narrower the row is one line of compact tiles that scrolls sideways: it takes a Tab stop only while it overflows.
 const [ref,focusable]=useOverflowFocusable<HTMLElement>(tiles.length,false);
 // The cut side fades (data-fade-start/-end, as on the tab bars), so a phone user sees that more tiles follow.
 const edges=useScrollEdges(ref,tiles.length);
 if(tiles.length<2)return null;
 return <section ref={ref} className={cx('sdx-kpi-row',className)} aria-label={label} tabIndex={focusable?0:undefined} data-fade-start={edges.start||undefined} data-fade-end={edges.end||undefined}>
  {entranceId?<EntranceList id={entranceId} className="sdx-kpi-grid">{tiles}</EntranceList>:<div className="sdx-kpi-grid">{tiles}</div>}
 </section>;
}

/** The finite values of a series; null, NaN and Infinity are dropped. */
export function sparklineValues(values:readonly (number|null|undefined)[]):number[]{
 return values.filter((value):value is number=>typeof value==='number'&&Number.isFinite(value));
}
// The data color of every single-series mark (chartSeries in chart.ts), never the scheme accent; warn and danger past their thresholds.
const sparklineStroke={normal:chartSeries,warning:'var(--sd-warn)',critical:'var(--sd-danger)'} as const;
/** A trend without axes: one line, 32px high, the full width of its slot. Renders nothing for fewer than 2 values. */
export function Sparkline({values,label,tone}:{values:readonly (number|null|undefined)[];label:string;tone?:'warning'|'critical'}){
 const points=sparklineValues(values);
 if(points.length<2)return null;
 const data=points.map((value,index)=>({index,value}));
 return <div className="sdx-sparkline" role="img" aria-label={label}>
  <ResponsiveContainer width="100%" height={32} minWidth={1}><LineChart data={data} margin={{top:3,right:2,bottom:3,left:2}}>
   <Line type="monotone" dataKey="value" stroke={sparklineStroke[tone??'normal']} strokeWidth={1.75} dot={false} activeDot={false} isAnimationActive={false}/>
  </LineChart></ResponsiveContainer>
 </div>;
}

// Entrance registry: an id plays its entrance once per page load (module
// state, so it survives tab switches, device changes and refreshes).
const entranceClaims=new Set<string>();
/** True the first time an id asks, false afterwards. */
export function claimEntrance(id:string):boolean{
 if(entranceClaims.has(id))return false;
 entranceClaims.add(id);
 return true;
}
/** The stagger of an entrance item in ms; items from the 9th on show at once (null). */
export function entranceDelay(index:number):number|null{
 return index>=0&&index<8?index*24:null;
}
// Longest stagger plus the slowest duration, with room: after it the classes go, which changes nothing visible.
const entranceWindow=8*24+260+300;
type EntranceState={phase:'idle'|'play'|'done';order:ReadonlyMap<string,number>};
const keyOf=(child:ReactNode)=>isValidElement(child)&&child.key!=null?String(child.key):null;
function entranceStart(id:string,items:ReactNode[]):EntranceState{
 // A development double render reuses the state of the first pass, so it does not claim twice.
 if(!claimEntrance(id))return {phase:'done',order:new Map()};
 const order=new Map<string,number>();
 items.slice(0,8).forEach((child,index)=>{const key=keyOf(child);if(key!==null)order.set(key,index);});
 return {phase:'play',order};
}
type EntranceChild=ReactElement<{className?:string;style?:CSSProperties}>;
/**
 * Staggers the first 8 children in (sdx-rise, index × 24 ms) the first time a
 * list with this id shows children in this page load. Later renders and
 * mounts with the same id show the children at once; a running entrance keeps
 * its classes until it has finished. Children take className and style.
 */
export function EntranceList({id,as:Tag='div',className,role,label,children}:{id:string;as?:'div'|'ul'|'ol'|'tbody';className?:string;
 /** For a list that needs its role restated (ul role="list") and a name. */
 role?:string;label?:string;children?:ReactNode}){
 const items=Children.toArray(children);
 const [state,setState]=useState<EntranceState>(()=>items.length?entranceStart(id,items):{phase:'idle',order:new Map()});
 let current=state;
 if(current.phase==='idle'&&items.length){current=entranceStart(id,items);setState(current);}
 useEffect(()=>{
  if(state.phase!=='play')return;
  const timer=setTimeout(()=>setState({phase:'done',order:new Map()}),entranceWindow);
  return ()=>clearTimeout(timer);
 },[state.phase]);
 return <Tag className={className} role={role} aria-label={label}>{current.phase!=='play'?items:items.map(child=>{
  const key=keyOf(child),index=key===null?undefined:current.order.get(key),delay=index===undefined?null:entranceDelay(index);
  if(delay===null||!isValidElement(child))return child;
  const element=child as EntranceChild;
  return cloneElement(element,{className:cx(element.props.className,'sdx-enter'),style:{...element.props.style,animationDelay:`${delay}ms`}});
 })}</Tag>;
}

/**
 * The props of Empty: icon, a title that states the fact, one sentence (children) and at most one action. art: a calm
 * illustration in place of the icon bubble (decorative, drawn with the tokens), for a surface whose empty state is a
 * good one, such as a Dashboard tile without alarms.
 */
export type EmptyProps={title:string;children?:ReactNode;action?:ReactNode}&({icon:IconType;art?:undefined}|{art:ReactNode;icon?:undefined});
export function Empty({icon:Icon,art,title,children,action}:EmptyProps){
 return <div className={cx('sdx-empty',art!==undefined&&'sdx-empty-with-art')}>{Icon?<span className="sdx-empty-icon"><Icon size={22} aria-hidden/></span>:<span className="sdx-empty-art" aria-hidden="true">{art}</span>}<strong>{title}</strong>{children&&<p>{children}</p>}{action}</div>;
}

export type SkeletonVariant='table'|'cards'|'facts'|'chart';
/**
 * First-load placeholder in the shape of the content (shared sdx-shimmer, still under reduced
 * motion): table = head bar plus row bars, cards = a grid of blocks, facts = label/value pairs,
 * chart = one block. With after (ms), a line says the load is slow, next to the optional action.
 */
export function Skeleton({variant='table',rows,label,after,action}:{variant?:SkeletonVariant;rows?:number;label:string;after?:number;action?:ReactNode}){
 const t=useT(),[slow,setSlow]=useState(false);
 useEffect(()=>{
  if(after===undefined)return;
  const timer=setTimeout(()=>setSlow(true),after);
  return ()=>clearTimeout(timer);
 },[after]);
 const count=Math.max(1,rows??(variant==='cards'?3:4)),list=Array.from({length:count},(_,index)=>index);
 return <div className={cx('sdx-skeleton-set','sdx-skeleton-'+variant)} role="status" aria-label={label}>
  <div className="sdx-skeleton-shapes" aria-hidden="true">
   {variant==='table'&&<><i className="sdx-skeleton-bar sdx-skeleton-head"/>{list.map(index=><i key={index} className="sdx-skeleton-bar sdx-skeleton-row"/>)}</>}
   {variant==='cards'&&list.map(index=><i key={index} className="sdx-skeleton-bar sdx-skeleton-card"/>)}
   {variant==='facts'&&list.map(index=><span key={index} className="sdx-skeleton-fact"><i className="sdx-skeleton-bar"/><i className="sdx-skeleton-bar"/></span>)}
   {variant==='chart'&&<i className="sdx-skeleton-bar sdx-skeleton-chart"/>}
  </div>
  {after!==undefined&&slow&&<p className="sdx-skeleton-slow"><span>{t('kit.skeleton.slow')}</span>{action}</p>}
 </div>;
}

/** A banner. success reports a finished check (for example a passed connection test); it is a status, never decoration. */
export function Notice({tone,icon:Icon,children,action}:{tone:'info'|'success'|'warning'|'danger';icon:IconType;children:ReactNode;action?:ReactNode}){
 return <div className={'sdx-notice sdx-notice-'+tone} role={tone==='danger'?'alert':'status'}><Icon size={16} aria-hidden/><div>{children}</div>{action}</div>;
}

const unavailableIcons:Record<UnavailableReason,IconType>={demo:FlaskConical,revoked:Ban,right:Lock,unreported:Clock3,agent:ArrowUpCircle,mode:ShieldCheck,offline:WifiOff};
export const unavailableTexts:Record<UnavailableReason,MessageKey>={demo:'kit.unavailable.demo',revoked:'kit.unavailable.revoked',right:'kit.unavailable.right',unreported:'kit.unavailable.unreported',agent:'kit.unavailable.agent',mode:'kit.unavailable.mode',offline:'kit.unavailable.offline'};
/**
 * A panel or area that cannot be used, with its concrete reason (unavailableReason in
 * ui/devices/device/device-unavailable.ts): an info Notice with the reason's icon and its full sentence.
 * children replaces the sentence with a feature-specific one ("You don't have the right to …");
 * nothing is glued together from fragments.
 */
export function Unavailable({reason,children,action}:{reason:UnavailableReason;children?:ReactNode;action?:ReactNode}){
 const t=useT();
 return <Notice tone="info" icon={unavailableIcons[reason]} action={action}>{children??t(unavailableTexts[reason])}</Notice>;
}

/**
 * The one panel notice of a device panel whose actions are blocked (nodiverna-ui §5): Unavailable with
 * two full sentences, the reason (kit.unavailable.<reason>) and then what the panel still offers
 * (readOnly, for example "You can still read the configuration."). Renders nothing without a reason.
 */
export function PanelUnavailable({reason,readOnly}:{reason:UnavailableReason|null;readOnly:string}){
 const t=useT();
 return reason?<Unavailable reason={reason}>{`${t(unavailableTexts[reason])} ${readOnly}`}</Unavailable>:null;
}

/** Relative time for timestamps such as heartbeats. Exact time stays in the tooltip. Without locale: defaultLocale (English) for callers that pass none. */
export const relativeTime=(value:number|null|undefined,now:number,locale:Locale=defaultLocale):string=>formatRelative(locale,value,now);
export const exactTime=(value:number|string|null|undefined,locale:Locale=defaultLocale)=>formatDateTime(locale,value);
export const percentLabel=(value:number|null,locale:Locale=defaultLocale)=>formatPercent(locale,value);
export const shortOs=(os?:string|null)=>os?.replace('Microsoft ','')??'';

/** The guarded close of the Drawer around it, for DrawerCancel and useDrawerClose; `then` runs once the drawer closed. */
const DrawerClose=createContext<((then?:()=>void)=>void)|null>(null);
/**
 * The guarded close of the surrounding Drawer (dirty asks "Discard changes?" first). `then` runs after the drawer
 * closed, also after Discard; it does not run when the user keeps editing. null outside a Drawer.
 */
export function useDrawerClose(){return useContext(DrawerClose);}
/**
 * Side panel from the right. Default surface for forms, details and settings; centred dialogs are reserved
 * for urgent prompts such as MFA. With dirty, a close by the user (Esc, the scrim, the head close button or
 * DrawerCancel) asks "Discard changes?" first; open={false} from the caller (after a successful submit)
 * closes it without the question. modal={false} renders no scrim and leaves the page usable: an outside
 * click does not close it, Esc closes it while focus is inside it.
 */
export function Drawer({open,onClose:closeDrawer,title,description,icon,iconTone='accent',children,footer,wide=false,returnFocus,dirty=false,modal=true,actions,flush=false,closeKey}:{open:boolean;onClose:()=>void;title:ReactNode;description?:ReactNode;
 /** An accent icon tile before the title (nodiverna-ui §8), the anchor of the drawer head. */
 icon?:IconType;
 /** The tone of the icon tile; danger for an irreversible delete (NameConfirmDrawer). */
 iconTone?:IconTone;children:ReactNode;footer?:ReactNode;wide?:boolean;
 /** Icon buttons in the drawer head, before the close button (actions on the whole drawer content). */
 actions?:ReactNode;
 /** The body has no padding and does not scroll itself: the content fills it and scrolls its own parts (a conversation). */
 flush?:boolean;
 /** The control that opened the drawer without being a radix trigger; focus goes back to it when the drawer closes. */
 returnFocus?:RefObject<HTMLElement|null>;
 /** The form holds input that a close would lose. */
 dirty?:boolean;
 /** false: no scrim, no focus trap, the page stays usable. */
 modal?:boolean;
 /** A change of this value asks for a close as the user would (dirty asks "Discard changes?" first), for example on a route change. */
 closeKey?:unknown}){
 const t=useT(),[asking,setAsking]=useState(false),content=useRef<HTMLDivElement>(null),opener=useRef<HTMLElement|null>(null),discarded=useRef(false);
 // The element that had focus when the drawer opened (before radix moves focus in): the return target without returnFocus.
 // A menu entry ("Create group" in the tree or header menu) unmounts with its menu, so its menu's trigger stands for it.
 useLayoutEffect(()=>{
  if(!open||typeof document==='undefined')return;
  const active=document.activeElement as HTMLElement|null;
  opener.current=active&&active!==document.body&&typeof active.focus==='function'?menuTrigger(active) as HTMLElement|null:null;
  discarded.current=false;
 },[open]);
 // The question ends when the caller closes the drawer or the form is clean again.
 const question=asking&&open&&dirty;
 if(asking&&!question)setAsking(false);
 // A close that hands over to another step (useDrawerClose with then) runs it after the close; a later request without
 // one drops it, so keeping the form and closing it another way runs nothing.
 const afterClose=useRef<(()=>void)|null>(null);
 const onClose=()=>{closeDrawer();const then=afterClose.current;afterClose.current=null;then?.();};
 const request=(then?:()=>void)=>{afterClose.current=then??null;if(dirty)setAsking(true);else onClose();};
 // A new closeKey while open runs the same guarded close; the latest request is read, so dirty is current.
 const closeSeen=useRef(closeKey),latestRequest=useRef(request);
 useEffect(()=>{latestRequest.current=request;});
 useEffect(()=>{
  if(Object.is(closeSeen.current,closeKey))return;
  closeSeen.current=closeKey;
  if(open)latestRequest.current();
 },[closeKey,open]);
 // On close: focus that already moved on (into the page next to a non-modal drawer, or into the next drawer) stays
 // there; otherwise it goes back to returnFocus, else to the element that had it when the drawer opened (radix itself
 // only returns focus to its Trigger, which a drawer opened from state does not have); when that is gone, to the top
 // open layer's first control, else the console's main region (drawerReturnTarget), never the body.
 const closeFocus=(event:Event)=>{
  const active=typeof document==='undefined'?null:document.activeElement;
  if(active&&active!==document.body&&!content.current?.contains(active)){event.preventDefault();return;}
  const target=drawerReturnTarget(returnFocus?.current,opener.current);if(target){event.preventDefault();target.focus();}
 };
 // Non-modal: the page stays clickable, and Esc closes only while focus is inside the drawer.
 const nonModal=modal?{}:{
  onInteractOutside:(event:Event)=>event.preventDefault(),
  onEscapeKeyDown:(event:Event)=>{if(!content.current?.contains(document.activeElement))event.preventDefault();},
 };
 return <DialogPrimitive.Root open={open} onOpenChange={next=>{if(!next)request();}} modal={modal}>
  <DialogPrimitive.Portal>
   {modal&&<DialogPrimitive.Overlay className="sdx-layer sdx-drawer-scrim"/>}
   <DialogPrimitive.Content ref={content} className={cx('sdx-layer','sdx-drawer',wide&&'sdx-drawer-wide',!modal&&'sdx-drawer-nonmodal')} onCloseAutoFocus={closeFocus} {...nonModal} {...(!description?{'aria-describedby':undefined}:{})}>
    <DrawerClose.Provider value={request}>
     {modal&&<ScrimLayerMark/>}
     <header className="sdx-drawer-head">
      {icon&&<IconTile icon={icon} tone={iconTone}/>}
      <div><DialogPrimitive.Title>{title}</DialogPrimitive.Title>{description&&<DialogPrimitive.Description>{description}</DialogPrimitive.Description>}</div>
      {actions&&<div className="sdx-drawer-head-actions">{actions}</div>}
      <DialogPrimitive.Close asChild><button type="button" className="sdx-icon-btn sdx-btn-ghost" aria-label={t('kit.close')} title={t('kit.closeEsc')}><X size={16} aria-hidden/></button></DialogPrimitive.Close>
     </header>
     <div className={cx('sdx-drawer-body',flush&&'sdx-drawer-body-flush')}>{children}</div>
     {footer&&<footer className="sdx-drawer-foot">{footer}</footer>}
    </DrawerClose.Provider>
   </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
  {/* Keep editing gives focus back into the drawer: to the element that had it, or (after a scrim click) to its first control.
      Discard closes the question and the drawer in one render: the question hands focus straight to the drawer's return
      target (closeFocusTo), so it never lands on a control of the closing drawer and then on the body. */}
  <ConfirmDialog open={question} onOpenChange={next=>{if(!next)setAsking(false);}} focusWithin={open?content:undefined} tone="danger" title={t('kit.discard.title')} body={t('kit.discard.body')}
   closeFocusTo={()=>discarded.current?drawerReturnTarget(returnFocus?.current,opener.current):null}
   confirmLabel={t('common.discard')} cancelLabel={t('kit.discard.keep')} onConfirm={()=>{discarded.current=true;setAsking(false);onClose();}}/>
 </DialogPrimitive.Root>;
}
/** The Cancel of a drawer footer: closes through the Drawer's guarded path (dirty asks first). It is never blocked, also while the drawer's request runs. */
export function DrawerCancel({label}:{label?:string}){
 const t=useT(),close=useContext(DrawerClose);
 return <Btn onClick={()=>close?.()}>{label??t('common.cancel')}</Btn>;
}

// ---- Settings page ----
/** The retry of a failed load: "Try again", repeating the same request. */
export function RetryAction({loading,onRetry}:{loading?:boolean;onRetry:()=>void}){
 const t=useT();
 return <Btn size="sm" icon={RefreshCw} loading={loading} onClick={onRetry}>{t('common.retry')}</Btn>;
}
/** The danger Notice of a failed load with its retry; stale content stays visible below it. */
export function LoadFailed({text,loading,onRetry}:{text:ReactNode;loading?:boolean;onRetry:()=>void}){
 return <Notice tone="danger" icon={AlertTriangle} action={<RetryAction loading={loading} onRetry={onRetry}/>}>{text}</Notice>;
}
/**
 * The frame of a Settings page (nodiverna-ui §4 "Settings panel"): one column of form cards, at most
 * 760px wide, and below it the full-width `wide` content (tables). loading (first load, no data): a facts
 * Skeleton with `label` in place of the children. loadError with onRetry: LoadFailed above the children;
 * without data (children null) it stands in their place.
 */
export function SettingsPage({label,loading=false,loadError,onRetry,retrying=false,wide,aside,className,children}:{
 /** The page name; the Skeleton's accessible name. */
 label:string;loading?:boolean;
 /** The load failure, for example "The settings could not be loaded." */
 loadError?:ReactNode;onRetry?:()=>void;
 /** The retry runs. */
 retrying?:boolean;wide?:ReactNode;
 /**
  * A companion of the cards, for example a live preview: a second column that stays in view beside the card column
  * while the page is at least 820px wide, else above the cards. It comes first in the document.
  */
 aside?:ReactNode;className?:string;children?:ReactNode}){
 const failed=loadError!=null&&loadError!==false&&loadError!=='',split=aside!=null&&aside!==false;
 const column=<div className="sdx-settings">
  {failed&&onRetry&&<LoadFailed text={loadError} loading={retrying} onRetry={onRetry}/>}
  {loading&&!failed?<Skeleton variant="facts" rows={3} label={label}/>:children}
 </div>;
 return <div className={cx('sdx-settings-page',split&&'sdx-settings-page-split',className)}>
  {split?<div className="sdx-settings-split"><div className="sdx-settings-aside">{aside}</div>{column}</div>:column}
  {wide!=null&&wide!==false&&<div className="sdx-settings-wide">{wide}</div>}
 </div>;
}

// ---- Copy ----
/** How long the copy icon shows the check. */
export const copiedFor=1200;
/**
 * Writes `value` to the clipboard and confirms with toast.success(success); without a clipboard, or
 * when the write is refused, toast.error(failed). Resolves whether it worked. sonner loads on the first
 * copy, so the kit module itself stays free of it (it touches document on load).
 */
export async function copyText(value:string,{success,failed}:{success:string;failed:string}):Promise<boolean>{
 const {toast}=await import('sonner');
 try{
  const clipboard=typeof navigator==='undefined'?undefined:navigator.clipboard;
  if(!clipboard)throw new Error('unavailable');
  await clipboard.writeText(value);
  toast.success(success);
  return true;
 }catch{toast.error(failed);return false;}
}
/** The copy action of a value: copy() runs copyText; copied is true for 1.2 s after a success. The timer ends on unmount. */
export function useCopy(value:string,texts:{success:string;failed:string}){
 const [copied,setCopied]=useState(false),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 useEffect(()=>()=>clearTimeout(timer.current),[]);
 const copy=async()=>{
  if(!await copyText(value,texts))return;
  setCopied(true);clearTimeout(timer.current);timer.current=setTimeout(()=>setCopied(false),copiedFor);
 };
 return [copied,copy] as const;
}
/**
 * A read-only value with its copy button (nodiverna-ui §8 feedback): mono text by default, or `display`
 * (a list, for example); the button's name is `label` ("Copy redirect URI"). A copy swaps the icon to a
 * check for 1.2 s and confirms with a toast (success, default kit.copy.done); a failure says so.
 */
export function CopyValue({value,label,success,display,mono=true,className}:{value:string;label:string;success?:string;display?:ReactNode;mono?:boolean;className?:string}){
 const t=useT(),[copied,copy]=useCopy(value,{success:success??t('kit.copy.done'),failed:t('kit.copy.failed')});
 return <div className={cx('sdx-copy-value',display!=null&&'sdx-copy-value-custom',className)}>
  {display??<code className={mono?'mono':undefined}>{value}</code>}
  <IconBtn icon={copied?Check:Copy} label={label} onClick={()=>void copy()}/>
 </div>;
}
/** A command to run (troubleshooting): an optional label, the scrollable pre (a Tab stop) and its copy button. tall allows 320px of height. */
export function CommandBlock({label,command,tall=false}:{label?:string;command:string;tall?:boolean}){
 const t=useT(),[copied,copy]=useCopy(command,{success:t('troubleshooting.copied'),failed:t('troubleshooting.copyFailed')});
 return <div className="sdx-command">
  {label&&<span className="sdx-command-label">{label}</span>}
  <div className="sdx-command-box">
   <pre className={tall?'sdx-command-tall':undefined} tabIndex={0} aria-label={label?t('troubleshooting.commandLabel',{label}):t('troubleshooting.command')}><code>{command}</code></pre>
   <IconBtn icon={copied?Check:Copy} label={t('troubleshooting.copy')} className="sdx-command-copy" onClick={()=>void copy()}/>
  </div>
 </div>;
}

// ---- Steps, Disclosure, DangerZone ----
export type StepState='done'|'current'|'waiting';
const stepStateTexts={done:'kit.steps.done',current:'kit.steps.current',waiting:'kit.steps.waiting'} as const satisfies Record<StepState,MessageKey>;
export type StepItem={id:string;title:ReactNode;state?:StepState;children?:ReactNode};
/**
 * A numbered sequence (ol): per step a number tile in the icon-tile look, the title and the body. state
 * shows as the tile's tone (done: success with a check) and as sr-only text; the current step has
 * aria-current="step".
 */
export function Steps({items,label,className}:{items:readonly StepItem[];label?:string;className?:string}){
 const t=useT();
 return <ol className={cx('sdx-steps',className)} aria-label={label}>
  {items.map((item,index)=><li key={item.id} className={cx('sdx-step',item.state&&'sdx-step-'+item.state)} aria-current={item.state==='current'?'step':undefined}>
   <span className="sdx-step-tile" aria-hidden="true">{item.state==='done'?<Check size={15} aria-hidden/>:index+1}</span>
   <h3 className="sdx-step-title">{item.title}{item.state&&<span className="sr-only"> ({t(stepStateTexts[item.state])})</span>}</h3>
   {item.children!=null&&<div className="sdx-step-body">{item.children}</div>}
  </li>)}
 </ol>;
}
/**
 * A styled details/summary: icon, title and hint in the summary, a chevron that turns when open, the
 * global focus ring. open + onOpenChange control it; the ref reaches the details element (scroll into view).
 */
export const Disclosure=forwardRef<HTMLDetailsElement,{title:ReactNode;hint?:ReactNode;icon?:IconType;open?:boolean;onOpenChange?:(open:boolean)=>void;className?:string;children:ReactNode}>(function Disclosure({title,hint,icon:Icon,open,onOpenChange,className,children},ref){
 return <details ref={ref} className={cx('sdx-disclosure',className)} open={open} onToggle={event=>onOpenChange?.(event.currentTarget.open)}>
  <summary>
   {Icon&&<Icon size={15} aria-hidden/>}
   <span className="sdx-disclosure-title"><strong>{title}</strong>{hint!=null&&hint!==''&&<small>{hint}</small>}</span>
   <ChevronRight size={16} className="sdx-disclosure-caret" aria-hidden/>
  </summary>
  <div className="sdx-disclosure-body">{children}</div>
 </details>;
});
/**
 * The last section of a settings page for an irreversible action: a section named by its title, one
 * consequence sentence and one danger Btn. The button is never natively disabled: loading while its own
 * request runs, blocked with a reason otherwise (also kit.busy while another change of the page runs).
 */
export function DangerZone({title,description,label,icon,blocked,loading,onClick}:{title:string;description:ReactNode;label:string;icon?:IconType;blocked?:string;loading?:boolean;onClick:()=>void}){
 const titleId=useId();
 return <section className="sdx-danger-zone" aria-labelledby={titleId}>
  <div><strong id={titleId}>{title}</strong><p>{description}</p></div>
  <div><Btn variant="danger" icon={icon} blocked={blocked} loading={loading} onClick={onClick}>{label}</Btn></div>
 </section>;
}

// ---- Pick list ----
/** One radio row of a PickList (.sdx-pick-list). */
export function PickRow({selected,icon,label,hint,level=0,onSelect}:{selected:boolean;icon:ReactNode;label:string;hint?:string;level?:number;onSelect:()=>void}){
 return <button type="button" role="radio" aria-checked={selected} className={cx('sdx-pick-row',selected&&'selected')} style={{paddingLeft:12+level*18}} onClick={onSelect}>
  <span className="sdx-pick-icon">{icon}</span><span className="sdx-pick-text"><strong>{label}</strong>{hint&&<small>{hint}</small>}</span>{selected&&<Check size={15} aria-hidden className="sdx-pick-check"/>}
 </button>;
}
/**
 * The checkbox handlers of a PickCheckRow. Available: a change reports the new state. Blocked: a click (also Space)
 * is cancelled, so the box keeps its state, and a change reports nothing.
 */
export function pickCheckHandlers(blocked:boolean,onChange:(checked:boolean)=>void){
 return {
  onClick:blocked?(event:{preventDefault:()=>void})=>event.preventDefault():undefined,
  onChange:(event:{target:{checked:boolean}})=>{if(!blocked)onChange(event.target.checked);},
 };
}
/**
 * One checkbox row of a PickList; without icon it has no icon tile (long lists such as the role permissions). mono shows
 * the hint as code (an id). blocked (for example adding is locked): the row stays focusable with aria-disabled, a click or
 * Space leaves the checkbox as it is, and the reason shows below the label as a second hint line that the checkbox names
 * through aria-describedby (like a blocked MenuEntry).
 */
export function PickCheckRow({checked,icon,label,hint,mono=false,blocked,onChange}:{checked:boolean;icon?:ReactNode;label:string;hint?:string;mono?:boolean;blocked?:string;onChange:(checked:boolean)=>void}){
 const reasonId=useId();
 return <label className={cx('sdx-pick-row',checked&&'selected',blocked&&'sdx-pick-blocked')}>
  <input type="checkbox" className="sdx-check" checked={checked} aria-disabled={blocked?true:undefined} aria-describedby={blocked?reasonId:undefined} {...pickCheckHandlers(!!blocked,onChange)}/>
  {icon!=null&&<span className="sdx-pick-icon">{icon}</span>}<span className="sdx-pick-text"><strong>{label}</strong>{hint&&<small className={mono?'mono':undefined}>{hint}</small>}{blocked&&<small id={reasonId} className="sdx-pick-reason">{blocked}</small>}</span>
 </label>;
}
/**
 * The pick list of a drawer: an optional search field, then the rows in a radiogroup (mode radio,
 * PickRow) or a group (mode checkbox, PickCheckRow) named by label; empty shows when there are no rows.
 */
export function PickList({mode,label,search,empty,children}:{mode:'radio'|'checkbox';label:string;search?:{value:string;onChange:(value:string)=>void;label:string;placeholder?:string};empty?:ReactNode;children?:ReactNode}){
 const rows=Children.toArray(children);
 return <div className="sdx-pick">
  {search&&<label className="sdx-searchfield sdx-pick-search"><Search size={14} aria-hidden/><input type="search" aria-label={search.label} placeholder={search.placeholder} value={search.value} onChange={event=>search.onChange(event.target.value)}/></label>}
  {rows.length?<div className="sdx-pick-list" role={mode==='radio'?'radiogroup':'group'} aria-label={label}>{rows}</div>:empty}
 </div>;
}

/** A catalog sentence with {name} placeholders that stand for inline elements such as code or links. */
export function RichText({text,parts}:{text:string;parts:Record<string,ReactNode>}){
 return <>{text.split(/\{(\w+)\}/).map((piece,index)=>index%2?<Fragment key={index}>{parts[piece]??piece}</Fragment>:piece)}</>;
}
