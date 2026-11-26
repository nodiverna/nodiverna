'use client';
// The widget catalog of the Dashboard's edit mode (docs/dashboard.md): every widget this viewer can use, grouped by
// topic, with a search. A row adds its widget to the draft (at the end, in its default size) or removes it again; the
// button stays in place, so the focus stays on it. The drawer is non-modal: the page behind it shows the draft.
import {useState,type RefObject} from 'react';
import {LayoutGrid,Minus,Plus,SearchX} from 'lucide-react';
import type {DashboardLayout,DashboardWidgetId} from '@/lib/dashboard-layout';
import {useLocale,useT} from '@/ui/base/locale';
import {Btn,Drawer,DrawerCancel,Empty,IconTile,StatusPill} from '@/ui/kit/kit';
import {Toolbar} from '@/ui/kit/data-table';
import {dashboardGroupLabels,dashboardWidgetGroups,dashboardWidgetMeta} from '@/ui/devices/dashboard/dashboard-widget-parts';

export function DashboardCatalogDrawer({open,draft,available,onAdd,onRemove,onClose,returnFocus}:{open:boolean;
 /** The widgets on the draft. */
 draft:DashboardLayout;
 /** The widgets this viewer can use, in catalog order. */
 available:readonly DashboardWidgetId[];
 onAdd:(id:DashboardWidgetId)=>void;onRemove:(id:DashboardWidgetId)=>void;onClose:()=>void;returnFocus?:RefObject<HTMLElement|null>}){
 const t=useT(),[locale]=useLocale(),[search,setSearch]=useState('');
 const needle=search.trim().toLocaleLowerCase(locale),on=new Set(draft.map(widget=>widget.id));
 const matches=available.filter(id=>!needle||(t(dashboardWidgetMeta[id].title)+' '+t(dashboardWidgetMeta[id].hint)).toLocaleLowerCase(locale).includes(needle));
 const groups=dashboardWidgetGroups.map(group=>({group,ids:matches.filter(id=>dashboardWidgetMeta[id].group===group)})).filter(entry=>entry.ids.length);
 return <Drawer open={open} onClose={onClose} modal={false} returnFocus={returnFocus} icon={LayoutGrid} title={t('dashboard.catalog.title')} description={t('dashboard.catalog.description')}
  footer={<DrawerCancel label={t('common.close')}/>}>
  <div className="sdx-dash-catalog">
   <Toolbar search={{value:search,onChange:setSearch,label:t('dashboard.catalog.search'),placeholder:t('dashboard.catalog.search')}}/>
   {groups.length?groups.map(({group,ids})=><section key={group} className="sdx-dash-catalog-group" aria-labelledby={'dashboard-catalog-'+group}>
    <h3 id={'dashboard-catalog-'+group}>{t(dashboardGroupLabels[group])}</h3>
    <ul>{ids.map(id=>{
     const meta=dashboardWidgetMeta[id],name=t(meta.title),added=on.has(id);
     return <li key={id} className="sdx-dash-catalog-row" data-added={added}>
      <IconTile icon={meta.icon} tone={added?'accent':'neutral'} size="sm"/>
      <span className="sdx-dash-catalog-text"><strong>{name}</strong><small>{t(meta.hint)}</small>{added&&<StatusPill kind="success" size="sm">{t('dashboard.catalog.added')}</StatusPill>}</span>
      <Btn id={'dashboard-catalog-'+id} size="sm" variant={added?'ghost':'secondary'} icon={added?Minus:Plus} aria-label={t(added?'dashboard.edit.remove':'dashboard.catalog.addNamed',{name})} onClick={()=>added?onRemove(id):onAdd(id)}>{t(added?'dashboard.catalog.remove':'dashboard.catalog.add')}</Btn>
     </li>;
    })}</ul>
   </section>):<Empty icon={SearchX} title={t('dashboard.catalog.noMatch')} action={<Btn size="sm" onClick={()=>setSearch('')}>{t('fleet.analysis.clearSearch')}</Btn>}>{t('dashboard.catalog.noMatchText')}</Empty>}
  </div>
 </Drawer>;
}
