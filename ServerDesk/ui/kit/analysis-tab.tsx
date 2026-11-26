'use client';
// The shared frame of the scope analysis tabs (nodiverna-ui §4, Console page point 5): one section
// labelled by the tab name, a SectionHead with the name only for screen readers (the scope tab shows
// it already) and the tab's description, meta and actions, then the notices, the Toolbar and the
// DataTable. Also the shared empty-state choice and actions, the first-load Skeleton and the load error
// with its retry, so every tab says and does the same thing in the same place.
import {useId,type ReactNode} from 'react';
import {MonitorSmartphone,X} from 'lucide-react';
import {Btn,RetryAction,SectionHead,Skeleton,cx,type EmptyProps,type SegmentItem} from '@/ui/kit/kit';
import {useT} from '@/ui/base/locale';

// The load error and its retry live in the kit (SettingsPage uses them too); the tabs import them from here.
export {LoadFailed,RetryAction} from '@/ui/kit/kit';

/**
 * One analysis tab: section aria-labelledby its sr-only h2, the SectionHead slots, then the content. The scope
 * Configuration and History subtabs use it too. headingId fixes the heading id for a panel that names it elsewhere;
 * busy sets aria-busy while the tab loads.
 */
export function AnalysisTab({title,description,meta,actions,className,headingId:fixedId,busy,children}:{title:string;description?:ReactNode;meta?:ReactNode;actions?:ReactNode;className?:string;headingId?:string;busy?:boolean;children:ReactNode}){
 const generated=useId(),headingId=fixedId??generated;
 return <section className={cx('sdx-health-tab',className)} aria-labelledby={headingId} aria-busy={busy||undefined}>
  <SectionHead title={title} hideTitle id={headingId} description={description} meta={meta} actions={actions}/>
  {children}
 </section>;
}

/**
 * The empty state of a report by its cause, in this order: no data at all (noData, today's no-inventory state), the
 * untouched default view is empty (emptyDefault: a title with the good fact, one sentence and one action that widens the
 * view), or the viewer's own search or filter matches nothing (noMatch, with its reset). A report without a default
 * filter passes no emptyDefault.
 */
export function reportEmpty({hasData,defaultView,noData,emptyDefault,noMatch}:{hasData:boolean;defaultView:boolean;noData:EmptyProps;emptyDefault?:EmptyProps;noMatch:EmptyProps}):EmptyProps{
 return !hasData?noData:defaultView&&emptyDefault?emptyDefault:noMatch;
}

/** "Show devices": the next step of an empty tab whose data comes from the devices (the Devices tab shows why nothing is reported). */
export function ShowDevicesAction({onShowDevices}:{onShowDevices:()=>void}){
 const t=useT();
 return <Btn icon={MonitorSmartphone} onClick={onShowDevices}>{t('fleet.analysis.showDevices')}</Btn>;
}
/** A reset of a search or filter that says what it resets ("Clear search", "Show all"). */
export function ResetAction({label,onReset}:{label:string;onReset:()=>void}){
 return <Btn variant="ghost" icon={X} onClick={onReset}>{label}</Btn>;
}

/** The first load: a table Skeleton with the tab's loading label; after 15 s it says so and offers the retry. */
export function FirstLoad({label,rows,loading,onRetry}:{label:string;rows?:number;loading?:boolean;onRetry:()=>void}){
 return <Skeleton variant="table" rows={rows} label={label} after={15000} action={<RetryAction loading={loading} onRetry={onRetry}/>}/>;
}

/**
 * The items of a status filter with the tone only on the worst status that has a count: the focal point
 * of the tab. worstFirst lists the ids from the worst to the best; ids not in it never carry a tone.
 */
export function worstTone<T extends string>(items:readonly SegmentItem<T>[],worstFirst:readonly T[]):SegmentItem<T>[]{
 const worst=worstFirst.find(id=>Number(items.find(item=>item.id===id)?.count??0)>0);
 return items.map(item=>item.id===worst?item:{...item,tone:undefined});
}
