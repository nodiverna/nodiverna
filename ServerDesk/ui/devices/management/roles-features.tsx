'use client';
// Management → Roles & features on the console kit: a SectionHead without a visible title, one kit Toolbar
// with the search and the Roles/Features Segmented (the view switch, with counts), the "Installed" card first
// (the focal point) and the catalog card, one row Menu per feature (Install… or Remove…) and the kit Drawer
// before every install or remove. The tree, its order, the orphan
// sections and the search ancestry come from ui/devices/management/feature-catalog.ts; the rules of the actions and the
// review lines of their confirmation from ui/devices/management/management-actions.ts.
import {useId,useMemo,useState,type FormEvent,type ReactNode} from 'react';
import {Blocks,CheckCircle2,ChevronDown,ChevronRight,Plus,Trash2} from 'lucide-react';
import type {Viewer,WindowsFeature} from '@/lib/types';
import {buildFeatureCatalog,filterFeatureTree,featureTypeLabel,type FeatureNode} from '@/ui/devices/management/feature-catalog';
import {deviceConnection} from '@/ui/base/ui-device';
import {unavailableReason} from '@/ui/devices/device/device-unavailable';
import {confirmationDevice,managementActionReason,managementMode,managementReview} from '@/ui/devices/management/management-actions';
import type {Confirmation} from '@/ui/base/confirmation';
import {permitted,type Device} from '@/ui/base/api';
import {Btn,Card,Drawer,Empty,Menu,PanelUnavailable,SectionHead,Segmented,Skeleton,StatusPill} from '@/ui/kit/kit';
import {Toolbar} from '@/ui/kit/data-table';
import {Field} from '@/ui/kit/field';
import {useLocale,useT} from '@/ui/base/locale';
import '@/ui/devices/management/roles-features.css';

type Props={server:Device;viewer:Viewer;demo:boolean;saving:boolean;onConfirm:(confirmation:Confirmation)=>void;now:number};
type Tab='roles'|'features';
type FeatureKind='install-feature'|'remove-feature';
type TreeProps={node:FeatureNode;tab:Tab;depth?:number;forceOpen:boolean;installedOnly?:boolean;reason:(kind:FeatureKind)=>string;onAction:(feature:WindowsFeature)=>void};

function FeatureTree({node,tab,depth=0,forceOpen,installedOnly=false,reason,onAction}:TreeProps){
  const t=useT(),[locale]=useLocale();
  const [expanded,setExpanded]=useState(false),childrenId=useId(),feature=node.feature;
  const hasChildren=node.children.length>0,open=forceOpen||expanded;
  const partiallyInstalled=!feature.installed&&node.installedDescendantCount>0;
  const blocked=reason(feature.installed?'remove-feature':'install-feature')||undefined;
  const count={installed:node.installedDescendantCount,count:node.descendantCount};
  return <li className={depth===0?'sdx-rf-node sdx-rf-root':'sdx-rf-node sdx-rf-child'}>
    <div className="sdx-rf-row">
      {hasChildren?<button className="sdx-rf-expand" type="button" aria-expanded={open} aria-controls={childrenId} aria-label={t(open?'roles.collapse':'roles.expand',{name:feature.displayName})} onClick={()=>setExpanded(!expanded)}>{open?<ChevronDown size={16} aria-hidden/>:<ChevronRight size={16} aria-hidden/>}</button>:<span className="sdx-rf-expand-placeholder"/>}
      <div className="sdx-rf-label">
        <strong>{feature.displayName}</strong>
        <small><span>{featureTypeLabel(feature,locale)} · <span className="mono">{feature.name}</span></span>{node.descendantCount>0&&<span>{t(tab==='roles'?'roles.roleServices':'roles.subfeatures',count)}</span>}</small>
      </div>
      <StatusPill kind={feature.installed?'success':partiallyInstalled?'warning':'neutral'}>{feature.installed?t('management.installed'):partiallyInstalled?t('roles.partial'):t('updates.available')}</StatusPill>
      {(!installedOnly||feature.installed)&&<Menu label={t('tree.actionsForName',{name:feature.displayName})} entries={[feature.installed
        ?{id:'remove',label:t('roles.menu.remove'),icon:Trash2,danger:true,blocked,onSelect:()=>onAction(feature)}
        :{id:'install',label:t('roles.menu.install'),icon:Plus,blocked,onSelect:()=>onAction(feature)}]}/>}
    </div>
    {hasChildren&&open&&<ul id={childrenId} className="sdx-rf-children">{node.children.map(child=><FeatureTree key={child.feature.name} {...{tab,depth:depth+1,forceOpen,installedOnly,reason,onAction}} node={child}/>)}</ul>}
  </li>;
}

/** An orphan section: role services whose role is missing, below a list. */
function Orphans({title,hasHierarchy,children}:{title:string;hasHierarchy:boolean;children:ReactNode}){
  const t=useT();
  return <div className="sdx-rf-orphans">
    <div className="sdx-rf-orphans-head"><h3>{title}</h3><small>{hasHierarchy?t('roles.parentMissing'):t('roles.noHierarchy')}</small></div>
    <ul className="sdx-rf-list">{children}</ul>
  </div>;
}

export default function RolesFeatures({server,viewer,demo,saving,onConfirm,now}:Props){
  const t=useT(),[locale]=useLocale();
  const snapshot=server.snapshot,reportedFeatures=snapshot?.features;
  const features=useMemo(()=>reportedFeatures??[],[reportedFeatures]);
  const catalog=useMemo(()=>buildFeatureCatalog(features),[features]);
  const [view,setView]=useState({serverId:server.id,tab:'roles' as Tab,query:''});
  const [draft,setDraft]=useState<{serverId:string;feature:WindowsFeature;includeManagementTools:boolean}|null>(null);
  const filters=view.serverId===server.id?view:{serverId:server.id,tab:'roles' as Tab,query:''};
  const change=(values:Partial<typeof filters>)=>setView({...filters,...values,serverId:server.id});
  const offline=deviceConnection(server,now,locale).kind!=='online';
  const management=managementMode(server),canOperate=permitted(server,viewer,'manage');
  const actionReason=(kind:FeatureKind)=>managementActionReason({demo,canOperate,canDiagnose:permitted(server,viewer,'diagnose'),offline,capabilities:snapshot?.agentCapabilities,domainRole:snapshot?.security?.domainRole,management},kind,locale);
  const reason=(kind:FeatureKind)=>actionReason(kind)||(saving?t('fleet.menu.saving'):'');
  // One panel notice (nodiverna-ui §5): offline and never-reported devices have the shared DeviceStateNotice.
  const notice=unavailableReason({demo,revoked:!!server.revoked,permitted:canOperate,reported:true,supported:true,management});
  const optionalOnly=features.length>0&&features.every(feature=>feature.featureType==='OptionalFeature');
  const tab:Tab=optionalOnly?'features':filters.tab,query=filters.query;
  const roots=tab==='roles'?catalog.roles:catalog.features;
  const filtered=(items:FeatureNode[],installedOnly=false)=>items.map(node=>filterFeatureTree(node,{query,installedOnly,locale})).filter((node):node is FeatureNode=>!!node);
  const installed=filtered(roots,true),available=filtered(roots),orphans=tab==='roles'?filtered(catalog.unassignedServices):[];
  const installedOrphans=tab==='roles'?filtered(catalog.unassignedServices,true):[];
  const installedCount=roots.filter(node=>node.feature.installed||node.installedDescendantCount>0).length;
  const loading=!demo&&!offline&&!Array.isArray(snapshot?.features);
  const open=draft?.serverId===server.id?draft:null;
  const kindOf=(feature:WindowsFeature):FeatureKind=>feature.installed?'remove-feature':'install-feature';
  const begin=(feature:WindowsFeature)=>{if(reason(kindOf(feature)))return;setDraft({serverId:server.id,feature,includeManagementTools:true});};
  const submit=(event:FormEvent)=>{
    event.preventDefault();
    if(!open)return;
    const kind=kindOf(open.feature);
    // Checked again right before the confirmation: the rights, the mode or the connection can change while the drawer is open.
    if(reason(kind))return;
    const params={name:open.feature.name,includeManagementTools:open.includeManagementTools};
    const description=t('management.feature.description',{displayName:open.feature.displayName});
    onConfirm({
      title:t(kind==='remove-feature'?'roles.title.remove':'roles.title.install',{name:open.feature.displayName}),
      description:`${managementReview(kind,params,snapshot,locale)}\n\n${description}`,
      lines:confirmationDevice(server.name,locale),
      confirmLabel:kind==='remove-feature'?t('common.remove'):t('roles.install'),
      ...(kind==='remove-feature'?{tone:'danger' as const}:{}),
      payload:{action:'job',id:server.id,kind,params,confirm:true},
    });
    setDraft(null);
  };
  const treeProps={tab,reason,onAction:begin,forceOpen:!!query.trim()};
  const installedEmpty=query?t(tab==='roles'?'roles.noInstalledRolesMatch':'roles.noInstalledFeaturesMatch'):features.length?t(tab==='roles'?'roles.noRolesInstalled':'roles.noFeaturesInstalled'):t('roles.noInventory');
  const catalogEmpty=query?t('roles.noMatch'):features.length?t(tab==='roles'?'roles.noRolesAvailable':'roles.noFeaturesAvailable'):t('roles.waiting');
  const drawerKind=open?kindOf(open.feature):'install-feature';
  return <div className="sdx-rf">
    <SectionHead hideTitle title={t('device.area.features')} description={t('roles.description')} meta={features.length?t('roles.metaInstalled',{count:installedCount}):undefined}/>
    <PanelUnavailable reason={notice} readOnly={t('roles.readOnly')}/>
    {loading&&!features.length?<Skeleton variant="table" label={t('roles.loading')} after={15000}/>:<>
      <div className="sdx-rf-content">
        {/* The view switch sits beside the search (a Segmented filter, not navigation); with optional features only there is nothing to switch. */}
        <Toolbar className="sdx-rf-toolbar" search={{value:query,onChange:value=>change({query:value}),label:t('roles.search'),placeholder:t('roles.searchPlaceholder')}}
          filters={!optionalOnly&&<Segmented<Tab> size="sm" label={t('roles.label')} value={tab} onChange={value=>change({tab:value})}
            items={[{id:'roles',label:t('roles.tab.roles'),count:catalog.roles.length},{id:'features',label:t('roles.tab.features'),count:catalog.features.length}]}/>}/>
        <Card title={t(tab==='roles'?'roles.installedRoles':'roles.installedFeatures')} icon={CheckCircle2} iconTone="success" meta={String(installedCount)} flush className="sdx-rf-card">
          {installed.length?<ul className="sdx-rf-list">{installed.map(node=><FeatureTree key={node.feature.name} node={node} {...treeProps} installedOnly/>)}</ul>
            :!installedOrphans.length&&<Empty icon={CheckCircle2} title={installedEmpty}/>}
          {installedOrphans.length>0&&<Orphans title={t('roles.orphans')} hasHierarchy={catalog.hasHierarchy}>{installedOrphans.map(node=><FeatureTree key={node.feature.name} node={node} {...treeProps} installedOnly/>)}</Orphans>}
        </Card>
        <Card title={tab==='roles'?t('roles.roleCatalog'):t('roles.featureCatalog')} icon={Blocks} iconTone="accent" meta={`${roots.length} · ${t('roles.alphabetical')}`} flush className="sdx-rf-card">
          {available.length?<ul className="sdx-rf-list">{available.map(node=><FeatureTree key={node.feature.name} node={node} {...treeProps}/>)}</ul>
            :<Empty icon={Blocks} title={catalogEmpty}/>}
          {orphans.length>0&&<Orphans title={t('roles.moreServices')} hasHierarchy={catalog.hasHierarchy}>{orphans.map(node=><FeatureTree key={node.feature.name} node={node} {...treeProps}/>)}</Orphans>}
        </Card>
      </div>
    </>}
    <Drawer open={!!open} onClose={()=>setDraft(null)} title={open?t(drawerKind==='remove-feature'?'roles.drawer.remove':'roles.drawer.install',{name:open.feature.displayName}):''}
      description={open?t('management.feature.description',{displayName:open.feature.displayName}):undefined}
      footer={<><Btn onClick={()=>setDraft(null)}>{t('common.cancel')}</Btn><Btn type="submit" form="sdx-rf-form" variant="primary" blocked={reason(drawerKind)||undefined}>{t('management.reviewChange')}</Btn></>}>
      {open&&<form id="sdx-rf-form" className="sdx-rf-form" onSubmit={submit} noValidate>
        <Field inline label={t('management.feature.includeTools')}><input name="includeManagementTools" type="checkbox" role="switch" checked={open.includeManagementTools} autoFocus onChange={event=>setDraft({...open,includeManagementTools:event.target.checked})}/></Field>
      </form>}
    </Drawer>
  </div>;
}
