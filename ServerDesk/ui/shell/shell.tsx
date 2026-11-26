'use client';
import {useEffect,useLayoutEffect,useRef,type ComponentType,type ReactNode,type RefObject} from 'react';
import {productName} from '@/lib/brand';
import {Activity,ChevronRight,CircleHelp,Clock3,FlaskConical,LogOut,PanelLeft,RefreshCw,Search,UserRound} from 'lucide-react';
import type {Viewer} from '@/lib/types';
import {accountDetail,accountName,viewerNameParts} from '@/lib/account-display';
import {Btn,IconBtn,Kbd,Menu,RichText,cx,iconButtonTip,type MenuEntry} from '@/ui/kit/kit';
import {Tooltip,TooltipProvider} from '@/ui/kit/tooltip';
import {BrandMark} from '@/ui/kit/brand-mark';
import {BrandLogo} from '@/ui/kit/brand-logo';
import type {BrandingLogoPair} from '@/lib/branding';
import {themeMenuEntry,useTheme} from '@/ui/shell/theme';
import {languageMenuEntry,useLocale,useT,type Translate} from '@/ui/base/locale';
import {useIdleSeconds} from '@/ui/session/session-idle';
import {countdownLabel} from '@/ui/session/session-idle-state';
import type {Area} from '@/ui/shell/nav-model';

type IconType=ComponentType<{size?:number;className?:string;'aria-hidden'?:boolean}>;
/** The rail areas (ui/shell/nav-model.ts). */
export type {Area};

export const initialsOf=(name:string)=>name.split('@')[0].split(/[.\s_-]+/).filter(Boolean).slice(0,2).map(part=>part[0]).join('').toUpperCase()||'SD';
/** The viewer's name: display name, email, local username, never an internal value (lib/account-display.ts); '' when none. */
export const displayNameOf=(viewer:Viewer)=>accountName(viewerNameParts(viewer));
/** The viewer's account detail below the name: the user name of a local account, the email of an Entra account (lib/account-display.ts). */
export const accountDetailOf=(viewer:Viewer)=>accountDetail({identitySource:viewer.identitySource,username:viewer.username,email:viewer.entra?.email});
/** The role line: up to three role names joined with ", ", then "{names} and {count} more"; "No role" without one. */
export function roleSummary(roles:readonly string[]|undefined,t:Translate):string{
 const names=roles??[];
 if(!names.length)return t('shell.role.none');
 return names.length<=3?names.join(', '):t('shell.roles.more',{names:names.slice(0,3).join(', '),count:names.length-3});
}

/**
 * The top bar status: the freshness of the console data or, inside the urgent window of the idle
 * timeout (useIdleSeconds), the pill "Sign-out in m:ss" in its place. In demo mode the demo pill takes the
 * place of the freshness ("Sample devices" with "End"); the idle pill still wins inside its window. Only this
 * part renders again every second while the countdown runs.
 */
export function TopbarStatus({freshness,demo=false,onEndDemo}:{freshness:string;demo?:boolean;onEndDemo?:()=>void}){
 const seconds=useIdleSeconds(),t=useT();
 if(seconds===null)return demo?<DemoPill onEnd={onEndDemo}/>:<span className="sdx-freshness" aria-live="polite">{freshness}</span>;
 return <Tooltip content={t('session.idle.hint')}>
  <span className="sdx-pill sdx-pill-warning sdx-idle-pill" role="timer" aria-label={t('session.idle.label')} aria-describedby="sdx-idle-pill-hint">
   <Clock3 size={14} aria-hidden/><span><RichText text={t('session.idle.countdown')} parts={{time:<b>{countdownLabel(seconds)}</b>}}/></span>
   <span id="sdx-idle-pill-hint" className="sr-only">{t('session.idle.hint')}</span>
  </span>
 </Tooltip>;
}

/**
 * The demo state in the top bar: "Sample devices" with the flask and a ghost "End" (accessible name "End sample
 * devices") that turns demo mode off. The tooltip and description say that the values are made up. At 760px or
 * narrower the text is hidden visually; it stays the group's name.
 */
export function DemoPill({onEnd}:{onEnd?:()=>void}){
 const t=useT();
 return <Tooltip content={t('console.demo.text')}>
  <span className="sdx-pill sdx-pill-accent sdx-demo-pill" role="group" aria-labelledby="sdx-demo-pill-label" aria-describedby="sdx-demo-pill-hint">
   <FlaskConical size={14} aria-hidden/><span id="sdx-demo-pill-label" className="sdx-demo-pill-label">{t('shell.freshness.demo')}</span>
   <Btn size="sm" variant="ghost" aria-label={t('shell.demo.endLabel')} onClick={()=>onEnd?.()}>{t('console.demo.end')}</Btn>
   <span id="sdx-demo-pill-hint" className="sr-only">{t('console.demo.text')}</span>
  </span>
 </Tooltip>;
}

/** The id of the navigator panel; the toggle, the crumb button and the bottom-bar item control it. */
export const navigatorId='sdx-navigator';

/**
 * Glass top bar: brand, navigator toggle, global search, status and the account menu. overlay (900px or narrower):
 * the toggle opens the navigator overlay, is named "Open navigator" and reports the overlay with aria-expanded;
 * wider, it shows or hides the docked navigator with aria-pressed.
 */
export function Topbar({viewer,saving,navigatorOpen,canToggleNavigator,onToggleNavigator,onSearch,onRefresh,loading,status,onHelp,onAccount,onSignOut,demo=false,onEndDemo,overlay=false,logo=null}:{viewer:Viewer;saving:boolean;navigatorOpen:boolean;canToggleNavigator:boolean;onToggleNavigator:()=>void;onSearch:()=>void;onRefresh:()=>void;loading:boolean;status:string;onHelp:()=>void;onAccount:()=>void;onSignOut:()=>void;
 /** Demo mode: the demo pill in place of the freshness text. */
 demo?:boolean;onEndDemo?:()=>void;
 /** 900px or narrower (useOverlayLayout): the navigator is an overlay. */
 overlay?:boolean;
 /** The uploaded logo (topbarLogo in ui/shell/brand-logo-model.ts) in place of the tile and the wordmark; null: the Nodiverna mark. */
 logo?:BrandingLogoPair|null}){
 const t=useT();
 const toggle=overlay
  ?<IconBtn icon={PanelLeft} label={t('shell.openNavigator')} aria-expanded={navigatorOpen} aria-controls={navigatorId} onClick={onToggleNavigator} className="sdx-navigator-toggle"/>
  :<IconBtn icon={PanelLeft} label={t(navigatorOpen?'shell.hideNavigator':'shell.showNavigator')} pressed={navigatorOpen} onClick={onToggleNavigator} className="sdx-navigator-toggle"/>;
 return <header className="sdx-topbar">
  <div className="sdx-topbar-start">
   {canToggleNavigator&&toggle}
   {/* The link keeps the product name as its accessible name; an uploaded logo sits on the glass bar, not on the tile, and a new one fades in (keyed by its URLs). */}
   <a className="sdx-brand" href="#devices" aria-label={t('shell.brandLabel')}>{logo
    ?<BrandLogo key={`${logo.light?.url??''}|${logo.dark?.url??''}`} light={logo.light} dark={logo.dark} size="topbar"/>
    :<><span className="sdx-logo" aria-hidden="true"><BrandMark size={16}/></span><strong>{productName}</strong></>}</a>
  </div>
  <button type="button" className="sdx-search" onClick={onSearch} aria-keyshortcuts="Control+K" aria-label={t('shell.searchLabel')}><Search size={15} aria-hidden/><span>{t('shell.search')}</span><Kbd>{t('shell.searchKeys')}</Kbd></button>
  <div className="sdx-topbar-end">
   <TopbarStatus freshness={status} demo={demo} onEndDemo={onEndDemo}/>
   <IconBtn icon={RefreshCw} label={t('shell.refresh')} shortcut="R" loading={loading} onClick={onRefresh}/>
   <IconBtn icon={CircleHelp} label={t('shell.help')} shortcut="F1" onClick={onHelp}/>
   <AccountMenu viewer={viewer} saving={saving} onAccount={onAccount} onSignOut={onSignOut}/>
  </div>
 </header>;
}

/**
 * The entries of the account menu: the head (avatar, name, account detail, roles), My account (G K),
 * Appearance, Language and Sign out, blocked while the console saves. Color scheme and start page live
 * in the Preferences card of My account.
 */
export function accountMenuEntries({viewer,saving,theme,setTheme,locale,setLocale,t,onAccount,onSignOut}:{viewer:Viewer;saving:boolean;
 theme:Parameters<typeof themeMenuEntry>[0];setTheme:Parameters<typeof themeMenuEntry>[1];locale:Parameters<typeof languageMenuEntry>[0];setLocale:Parameters<typeof languageMenuEntry>[1];
 t:Translate;onAccount:()=>void;onSignOut:()=>void}):MenuEntry[]{
 const name=displayNameOf(viewer),detail=accountDetailOf(viewer);
 return [
  {id:'head',head:<div className="sdx-account-head"><span className="sdx-avatar" aria-hidden="true">{initialsOf(name)}</span><div>{name&&<strong>{name}</strong>}{detail&&<small>{detail}</small>}<small className="sdx-account-roles">{roleSummary(viewer.roles,t)}</small></div></div>},
  {id:'head-separator',separator:true},
  {id:'account',label:t('shell.myAccount'),icon:UserRound,shortcut:'G K',onSelect:onAccount},
  {id:'account-separator',separator:true},
  themeMenuEntry(theme,setTheme,t),
  {id:'theme-separator',separator:true},
  languageMenuEntry(locale,setLocale,t),
  {id:'language-separator',separator:true},
  {id:'sign-out',label:t('shell.signOut'),icon:LogOut,blocked:saving?t('shell.signOutBlocked'):undefined,onSelect:onSignOut},
 ];
}

/** The avatar button and its account menu (kit Menu, .sdx-account-menu). */
export function AccountMenu({viewer,saving,onAccount,onSignOut,open,onOpenChange}:{viewer:Viewer;saving:boolean;onAccount:()=>void;onSignOut:()=>void;open?:boolean;onOpenChange?:(open:boolean)=>void}){
 const t=useT(),[theme,setTheme]=useTheme(),[locale,setLocale]=useLocale(),name=displayNameOf(viewer),label=name?t('shell.accountLabel',{name}):t('shell.myAccount');
 return <Menu label={label} className="sdx-account-menu" open={open} onOpenChange={onOpenChange} entries={accountMenuEntries({viewer,saving,theme,setTheme,locale,setLocale,t,onAccount,onSignOut})}
  trigger={<button type="button" className="sdx-avatar-btn" aria-label={label} title={name||undefined}><span className="sdx-avatar" aria-hidden="true">{initialsOf(name)}</span></button>}/>;
}

export type RailItem={id:Area;label:string;icon:IconType;shortcut:string;onSelect:()=>void;placement?:'end';
 /** 900px or narrower, the active item of an area with a navigator: whether the navigator overlay it toggles is open. */
 expanded?:boolean};
/** The Jobs item of the bottom bar (900px or narrower only): the count of running and waiting jobs, the sheet state, the opener. */
export type RailJobs={count:number;open:boolean;onSelect:()=>void};
/**
 * Area switcher. On small screens it becomes the bottom tab bar. Entries with placement 'end' sit at the bottom (desktop)
 * or last (mobile). Each item explains itself with the kit Tooltip, its label and its G shortcut ("Settings (G S)").
 * jobs: the Jobs item before the end entries, shown only in the bottom bar (sdx-rail-mobile): it opens the Jobs sheet,
 * its badge counts the running and waiting jobs (hidden from screen readers; the name says "{count} running or waiting").
 * jobsRef: the Jobs button, where the sheet gives focus back.
 */
export function Rail({items,area,jobs,jobsRef}:{items:RailItem[];area:Area;jobs?:RailJobs;jobsRef?:RefObject<HTMLButtonElement|null>}){
 const t=useT();
 const item=(entry:RailItem)=><Tooltip key={entry.id} side="right" content={iconButtonTip(entry.label,entry.shortcut,t('kit.ctrl'))}><button type="button" className={cx('sdx-rail-item',entry.placement==='end'&&'sdx-rail-item-end',area===entry.id&&'active')} aria-current={area===entry.id?'page':undefined} aria-expanded={entry.expanded} aria-controls={entry.expanded===undefined?undefined:navigatorId} onClick={entry.onSelect}>
   <span className="sdx-rail-icon"><entry.icon size={19} aria-hidden/></span><span className="sdx-rail-label">{entry.label}</span>
  </button></Tooltip>;
 const jobsItem=jobs&&<Tooltip key="jobs" side="top" content={iconButtonTip(t('jobs.title'),'T',t('kit.ctrl'))}><button ref={jobsRef} type="button" className="sdx-rail-item sdx-rail-mobile sdx-rail-jobs" aria-expanded={jobs.open} aria-haspopup="dialog" aria-keyshortcuts="T" onClick={jobs.onSelect}>
   <span className="sdx-rail-icon"><Activity size={19} aria-hidden/>{jobs.count>0&&<b key={jobs.count} className="sdx-rail-badge" aria-hidden="true">{jobs.count}</b>}</span><span className="sdx-rail-label">{t('jobs.title')}</span>
   {jobs.count>0&&<span className="sr-only">{t('jobs.badgeLabel',{count:jobs.count})}</span>}
  </button></Tooltip>;
 return <TooltipProvider><nav className="sdx-rail" aria-label={t('shell.areas')}>
  {items.filter(entry=>entry.placement!=='end').map(item)}
  {jobsItem}
  {items.filter(entry=>entry.placement==='end').map(item)}
 </nav></TooltipProvider>;
}

/**
 * Where focus goes when the navigator overlay opens: the tree's Tab stop (the selected device, group or customer), else
 * the selected tree item, else the current page link (Automation, Settings), else the first button or link, else the
 * panel itself. Never a text field: on a phone, focusing the tree filter would raise the on-screen keyboard over the
 * tree the user came to pick from. On the tree item the arrow keys work at once.
 */
export function navigatorFocusTarget(panel:HTMLElement):HTMLElement{
 const ready=':not([disabled]):not([tabindex="-1"]):not([aria-hidden="true"])';
 return panel.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')
  ??panel.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]')
  ??panel.querySelector<HTMLElement>('a[aria-current="page"]')
  ??panel.querySelector<HTMLElement>(`:is(button, a[href], [tabindex]):not(input, select, textarea, [contenteditable])${ready}`)
  ??panel;
}
/** Scrolls only the navigator body so the focus target is in view; the page behind the overlay never moves. */
function revealInBody(panel:HTMLElement,target:HTMLElement){
 const body=panel.querySelector<HTMLElement>('.sdx-navigator-body');
 if(!body||target===panel||!body.contains(target)||typeof target.getBoundingClientRect!=='function')return;
 const box=body.getBoundingClientRect(),item=target.getBoundingClientRect();
 if(item.top<box.top||item.bottom>box.bottom)body.scrollTop+=item.top-box.top-(box.height-item.height)/2;
}

/**
 * Context panel next to the rail: the device tree or the pages of the current area. overlay (900px or narrower): it
 * is an overlay over the workspace; opening it moves focus into it (navigatorFocusTarget, never the tree filter), and
 * Esc closes it and gives focus back to the control that opened it (toggle, crumb button or bottom-bar item). Esc is
 * left to a dialog, a drawer with focus inside or a menu that has it. Any other close (a choice, the console opening
 * the palette, Help or the Jobs sheet) that finds focus still inside the panel hands it to the opener as well.
 */
export function Navigator({title,actions,children,footer,open,onClose,overlay=false}:{title:string;actions?:ReactNode;children:ReactNode;footer?:ReactNode;open:boolean;onClose:()=>void;overlay?:boolean}){
 const panel=useRef<HTMLElement>(null),opener=useRef<HTMLElement|null>(null),close=useRef(onClose);
 useLayoutEffect(()=>{close.current=onClose;});
 const active=overlay&&open;
 useEffect(()=>{
  if(!active||typeof document==='undefined')return;
  // The opener: the element that had focus outside the panel (toggle, crumb button or bottom-bar item).
  const before=document.activeElement as HTMLElement|null;
  opener.current=before&&before!==document.body&&typeof before.focus==='function'&&!panel.current?.contains(before)?before:null;
  if(panel.current){const target=navigatorFocusTarget(panel.current);target.focus({preventScroll:true});revealInBody(panel.current,target);}
  const onKey=(event:KeyboardEvent)=>{
   if(event.key!=='Escape')return;
   // A dialog, a drawer with focus inside or an open menu handles its own Esc first. A non-modal drawer (Help) cancels
   // the Esc it ignores (focus outside it), so a cancelled Esc still counts while focus is inside the navigator.
   const target=event.target as Element|null,inside=!!target&&!!panel.current?.contains(target);
   if(event.defaultPrevented&&!inside)return;
   if(typeof target?.closest==='function'&&target.closest('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]'))return;
   event.preventDefault();
   const back=opener.current;opener.current=null;
   close.current();
   if(back?.isConnected)back.focus();
  };
  document.addEventListener('keydown',onKey);
  return ()=>document.removeEventListener('keydown',onKey);
 },[active]);
 // Closed while focus is still inside (a choice, or the console opening the palette, Help or the Jobs sheet): focus would
 // stay on a hidden control. This runs in the layout phase of the closing commit: after React's focus restore at the end
 // of the mutation phase (which undoes a focus move made in an effect cleanup) and before a layer that opens in the same
 // commit remembers the focused element (Help's layout effect runs after this one, the palette's in a passive effect).
 useLayoutEffect(()=>{
  if(active)return;
  const back=opener.current,node=panel.current,focused=typeof document==='undefined'?null:document.activeElement;
  opener.current=null;
  if(back?.isConnected&&node&&focused&&node.contains(focused))back.focus({preventScroll:true});
 },[active]);
 return <>
  <div className={cx('sdx-navigator-scrim',open&&'open')} onClick={onClose} aria-hidden="true"/>
  <aside ref={panel} id={navigatorId} className={cx('sdx-navigator',open&&'open')} aria-label={title} tabIndex={overlay?-1:undefined}>
   <header className="sdx-navigator-head"><h2>{title}</h2>{actions&&<div>{actions}</div>}</header>
   <div className="sdx-navigator-body">{children}</div>
   {footer&&<footer className="sdx-navigator-foot">{footer}</footer>}
  </aside>
 </>;
}

export type NavEntry={id:string;label:string;icon:IconType;href?:string;badge?:ReactNode};
/** Page list of an area, e.g. the pages of a navigator group: one line per page, the icon without a tile, then the label. The page hint is the page subtitle. */
export function NavList({items,value,onSelect,label}:{items:NavEntry[];value:string;onSelect:(id:string)=>void;label:string}){
 return <ul className="sdx-navlist" aria-label={label}>{items.map(item=><li key={item.id}><a href={item.href} className={cx(value===item.id&&'active')} aria-current={value===item.id?'page':undefined} onClick={event=>{if(event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();onSelect(item.id);}}>
  <item.icon size={16} className="sdx-navlist-glyph" aria-hidden/><strong className="sdx-navlist-label">{item.label}</strong>{item.badge}
 </a></li>)}</ul>;
}

export type NavGroup={label:string;items:NavEntry[]};
/** Page lists under small headings, e.g. the groups of the settings. Empty groups are left out, heading included. */
export function NavGroups({groups,value,onSelect,label}:{groups:NavGroup[];value:string;onSelect:(id:string)=>void;label:string}){
 return <div className="sdx-navgroups" role="group" aria-label={label}>{groups.filter(group=>group.items.length>0).map(group=><section key={group.label} className="sdx-navgroup">
  <h3 className="sdx-navlist-heading">{group.label}</h3>
  <NavList items={group.items} value={value} onSelect={onSelect} label={group.label}/>
 </section>)}</div>;
}

export type Crumb={label:string;href?:string;onSelect?:()=>void};
export function Breadcrumbs({items}:{items:Crumb[]}){
 const t=useT();
 return <nav className="sdx-crumbs" aria-label={t('shell.path')}><ol>{items.map((crumb,index)=><li key={index}>{index>0&&<ChevronRight size={12} aria-hidden/>}{crumb.onSelect&&index<items.length-1?<a href={crumb.href} onClick={event=>{if(event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();crumb.onSelect?.();}}>{crumb.label}</a>:<span aria-current={index===items.length-1?'page':undefined}>{crumb.label}</span>}</li>)}</ol></nav>;
}

/**
 * The crumb button of a page whose hierarchy is the navigator (Automation, Settings): the area name, at 900px or
 * narrower only. It opens the navigator overlay; expanded is whether the overlay is open.
 */
export type AreaCrumb={label:string;expanded:boolean;onSelect:()=>void};
/**
 * Title block of the workspace: path, title, status and one primary action. description: an optional block below the
 * name line and above the subtitle (the device description). className: a page variant (the device header,
 * sdx-page-head-device). compact (760px or narrower, useNarrowLayout): one title line; the title ellipsizes and the
 * actions and the primary follow it on the same line, so pass them as icon buttons (IconBtn, the primary with
 * variant="primary", a Menu trigger); the subtitle is one line with ellipsis. Crumbs and description stay.
 */
export function PageHeader({crumbs,areaCrumb,icon,title,description,subtitle,badges,actions,primary,className,compact=false}:{crumbs?:Crumb[];areaCrumb?:AreaCrumb;icon?:ReactNode;title:ReactNode;description?:ReactNode;subtitle?:ReactNode;badges?:ReactNode;actions?:ReactNode;primary?:ReactNode;className?:string;compact?:boolean}){
 const t=useT(),hasActions=!!(actions||primary);
 return <header className={cx('sdx-page-head',compact&&'sdx-page-head-compact',className)}>
  {crumbs&&<div className="sdx-page-path"><Breadcrumbs items={crumbs}/></div>}
  {!crumbs&&areaCrumb&&<div className="sdx-page-path sdx-page-path-area"><Btn size="sm" variant="ghost" icon={PanelLeft} className="sdx-area-crumb" aria-label={t('shell.areaPages',{area:areaCrumb.label})} aria-expanded={areaCrumb.expanded} aria-controls={navigatorId} onClick={areaCrumb.onSelect}>{areaCrumb.label}</Btn></div>}
  <div className="sdx-page-title">
   {icon}
   <div className="sdx-page-copy"><div className="sdx-page-line"><h1>{title}</h1>{badges}{compact&&hasActions&&<span className="sdx-page-line-actions">{actions}{primary}</span>}</div>{description}{subtitle&&<p>{subtitle}</p>}</div>
   {!compact&&hasActions&&<div className="sdx-page-actions">{actions}{primary}</div>}
  </div>
 </header>;
}
