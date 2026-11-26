'use client';
// The Assignments tab of the three Automation pages: a "Templates" Card and an "Assignments" Card, each with its
// DataTable and a row Menu, and the inheritance help as a Disclosure. Without templates the tab is one Empty that
// creates the first template. The page (automation-workspace.tsx) owns the data, the drawers and the confirmations;
// this file only renders and reports the chosen action.
import {FileCode2,Folder,GitBranch,Info,Play,Plus,Server,Trash2} from 'lucide-react';
import {Btn,Card,Disclosure,Empty,Menu,StatusPill,type MenuEntry} from '@/ui/kit/kit';
import {DataTable,type DataColumn} from '@/ui/kit/data-table';
import {assignmentScope,templateBehaviour,type AutomationAssignment,type AutomationGroup,type AutomationTemplate} from '@/ui/automation/automation-data';
import {catalogOwnerLabel} from '@/ui/base/catalog-owner';
import type {AutomationKind} from '@/lib/automation-resolution';
import type {Device} from '@/ui/base/api';
import {useLocale,useT} from '@/ui/base/locale';

export function AutomationAssignments({kind,templates,assignments,groups,servers,showOwner,createBlocked,manageBlocked,showCreate,highlight,onCreate,onAssign,onStart,onRemove}:{
 kind:AutomationKind;templates:readonly AutomationTemplate[];assignments:readonly AutomationAssignment[];groups:readonly AutomationGroup[];servers:readonly Device[];
 /** The separated catalog shows its owner tag on each template. */
 showOwner:boolean;
 /** Why "Create template" cannot start (right, sample devices, catalog lock); undefined when it can. */
 createBlocked?:string;
 /** Why no assignment can change (right, sample devices, another change runs); undefined when it can. */
 manageBlocked?:string;
 /** The Templates card offers "Create template"; on Configuration drift the page primary already does. */
 showCreate:boolean;
 /** The assignment row to highlight ("Show assignment" from the Schedules tab). */
 highlight?:string;
 onCreate:()=>void;onAssign:(templateId?:string)=>void;onStart:(assignment:AutomationAssignment)=>void;onRemove:(assignment:AutomationAssignment)=>void}){
 const t=useT(),[locale]=useLocale();
 const createButton=<Btn icon={Plus} blocked={createBlocked} onClick={onCreate}>{t('automation.createTemplate')}</Btn>;
 if(!templates.length)return <Card><Empty icon={FileCode2} title={t('automation.noTemplates')} action={createButton}>{t('automation.noTemplatesHint')}</Empty></Card>;
 const scopeOf=(a:AutomationAssignment)=>{const scope=assignmentScope(a,groups,servers);return {name:scope.name??(a.scopeType==='group'?t('fleet.col.group'):t('fleet.col.device')),path:scope.path};};
 const templateColumns:DataColumn<AutomationTemplate>[]=[
  {id:'name',label:t('common.name'),primary:true,wrap:true,cell:entry=><span className="sdx-cell-stack"><strong>{entry.name}</strong>{showOwner&&<span className="sd-catalog-owner" data-owner={entry.customerId?'customer':'library'}>{catalogOwnerLabel(entry,locale)}</span>}</span>},
  {id:'behaviour',label:t('automation.behaviour'),cell:entry=>{const behaviour=templateBehaviour(entry);return t(behaviour.key,behaviour.params);}},
  {id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',cell:entry=><Menu label={t('automation.rowActions',{name:entry.name})} entries={[{id:'assign',label:t('automation.assignTemplateAction'),icon:GitBranch,blocked:manageBlocked,onSelect:()=>onAssign(entry.id)}]}/>},
 ];
 const assignmentMenu=(a:AutomationAssignment):MenuEntry[]=>[
  ...(kind==='runbook'&&!a.disabled?[{id:'start',label:t('automation.menu.start'),icon:Play,blocked:manageBlocked,onSelect:()=>onStart(a)},{id:'separator',separator:true} as const]:[]),
  {id:'remove',label:t('automation.menu.remove'),icon:Trash2,danger:true,blocked:manageBlocked,onSelect:()=>onRemove(a)},
 ];
 const assignmentColumns:DataColumn<AutomationAssignment>[]=[
  {id:'scope',label:t('rbac.scopeColumn'),primary:true,wrap:true,cell:a=>{const scope=scopeOf(a),Icon=a.scopeType==='group'?Folder:Server;return <span className="sdx-cell-stack"><strong><Icon size={14} aria-hidden/> {scope.name}</strong>{scope.path&&<small>{scope.path}</small>}</span>;}},
  {id:'template',label:t('automation.line.template'),wrap:true,cell:a=>a.templateName},
  {id:'mode',label:t('customers.mode'),cell:a=>a.disabled?<StatusPill kind="neutral">{t('automation.state.paused')}</StatusPill>:<StatusPill kind="accent">{a.scopeType==='group'?t('automation.withSubgroups'):t('automation.direct')}</StatusPill>},
  {id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',cell:a=><Menu label={t('automation.rowActions',{name:scopeOf(a).name})} entries={assignmentMenu(a)}/>},
 ];
 const assignButton=<Btn icon={GitBranch} blocked={manageBlocked??(templates.length?undefined:t('automation.blocked.noTemplates'))} onClick={()=>onAssign()}>{t('automation.assignTemplateAction')}</Btn>;
 return <div className="sdx-panel-stack">
  <Card title={t('automation.templates')} icon={FileCode2} iconTone="accent" meta={String(templates.length)} actions={showCreate?createButton:undefined} flush>
   <DataTable<AutomationTemplate> label={t('automation.templates')} variant="flush" cards entranceId="automation-templates" columns={templateColumns} rows={templates} rowKey={entry=>entry.id}
    empty={{icon:FileCode2,title:t('automation.noTemplates')}}/>
  </Card>
  <Card title={t('automation.assignments')} icon={GitBranch} iconTone="accent" meta={assignments.length?String(assignments.length):undefined} actions={assignButton} flush>
   <DataTable<AutomationAssignment> label={t('automation.assignments')} variant="flush" cards entranceId="automation-assignments" columns={assignmentColumns} rows={assignments} rowKey={a=>a.id} highlightKey={highlight}
    empty={{icon:GitBranch,title:t('automation.noAssignments'),children:t('automation.noAssignmentsHint'),action:assignButton}}/>
  </Card>
  <Disclosure title={t('automation.inheritance')} icon={Info}>{t('automation.inheritanceHint')}</Disclosure>
 </div>;
}
