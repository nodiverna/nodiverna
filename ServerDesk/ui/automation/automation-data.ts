// The data of the Automation pages (GET /api/automation) and its pure helpers: the group path of a scope, the
// effective assignment of a device (the same resolution as the server), the behaviour line of a template, the
// state pill of a device and the runbook assignments that run on a recurrence (the Schedules tab).
import {resolveAutomation,type AutomationCandidate,type AutomationKind} from '@/lib/automation-resolution';
import type {MessageKey} from '@/lib/i18n/translate';
import type {StatusKind} from '@/ui/kit/kit';
import type {CatalogOwnership} from '@/ui/base/catalog-owner';
import type {AutomationPage} from '@/lib/console-route';
import type {Device} from '@/ui/base/api';

export type AutomationTemplate={id:string;kind:AutomationKind;slot:string;name:string;createdAt:number;payload:Record<string,unknown>;customerId?:string|null;customerName?:string|null};
/** nextDue: the next run of a runbook assignment with a recurrence, null before its first evaluation and for the other kinds. */
export type AutomationAssignment={id:string;kind:AutomationKind;slot:string;scopeType:'group'|'device';scopeId:string;templateId:string;templateName:string;disabled:boolean;createdAt:number;nextDue?:number|null};
export type AutomationGroup={id:string;name:string;parentId:string|null;depth:number;customerId?:string};
export type AutomationState={serverId:string;kind:AutomationKind;slot:string;assignmentId:string|null;status:string;message:string;updatedAt:number};
export type AutomationData={templates:AutomationTemplate[];assignments:AutomationAssignment[];groups:AutomationGroup[];states:AutomationState[];catalog?:CatalogOwnership};
export const emptyAutomation:AutomationData={templates:[],assignments:[],groups:[],states:[]};

/** The template kind of each automation page. */
export const automationKinds:Record<AutomationPage,AutomationKind>={runbooks:'runbook',desired:'desired',drift:'drift'};
/** The right that manages templates and assignments of a kind. */
export const automationRights:Record<AutomationKind,string>={drift:'drift.manage',desired:'desired.manage',runbook:'runbooks.manage'};
/** The reason a viewer without the right sees on blocked actions. */
export const automationRightReasons:Record<AutomationKind,MessageKey>={drift:'drift.blocked.manage',desired:'desired.blocked.manage',runbook:'runbooks.blocked.manage'};

/** The device states of automation_device_state: label and pill. Unknown states show their raw value as a neutral pill. */
export const automationStates:Record<string,{label:MessageKey;kind:StatusKind}>={
 applied:{label:'management.active',kind:'success'},pending:{label:'device.protection.pending',kind:'waiting'},scheduled:{label:'automation.state.scheduled',kind:'accent'},
 disabled:{label:'automation.state.paused',kind:'neutral'},paused:{label:'automation.state.paused',kind:'neutral'},skipped:{label:'automation.state.skipped',kind:'neutral'},
 conflict:{label:'automation.state.conflict',kind:'warning'},blocked:{label:'automation.state.blocked',kind:'warning'},local_override:{label:'automation.state.localOverride',kind:'warning'},
 removed:{label:'management.removed',kind:'neutral'},
};

/** "Parent / Child / Group": the names from the root group down to the group. */
export function automationGroupPath(group:AutomationGroup,groups:readonly AutomationGroup[]):string{const names=[group.name],visited=new Set([group.id]);let parent=groups.find(g=>g.id===group.parentId);while(parent&&!visited.has(parent.id)){names.unshift(parent.name);visited.add(parent.id);parent=groups.find(g=>g.id===parent?.parentId);}return names.join(' / ');}

/** The assignments that apply to a device per slot, resolved like the server: device first, then the deepest group. */
export function effectiveDeviceAssignments(server:Device,data:Pick<AutomationData,'assignments'|'groups'>,kind:AutomationKind){
 const members=server.groups??(server.groupId?[{id:server.groupId,name:server.groupName??'',parentId:null,depth:0,direct:true}]:[]),ids=new Set(members.map(g=>g.id));
 const candidates:AutomationCandidate[]=data.assignments.filter(a=>a.kind===kind&&(a.scopeType==='device'?a.scopeId===server.id:ids.has(a.scopeId))).map(a=>({...a,payload:{},actor:'',authVersion:0,priority:a.scopeType==='device'?5:data.groups.find(g=>g.id===a.scopeId)?.depth??members.find(g=>g.id===a.scopeId)?.depth??0}));
 return resolveAutomation(candidates);
}

/** The behaviour line of a template: shared baseline or data sources, the check interval, or manual or scheduled start. */
export function templateBehaviour(template:AutomationTemplate):{key:MessageKey;params?:Record<string,number>}{
 if(template.kind==='drift')return {key:template.payload.hasBaseline?'automation.sharedBaseline':'automation.dataSources'};
 if(template.kind==='desired'){const seconds=Number(template.payload.intervalSeconds);return seconds?{key:'automation.checkEvery',params:{value:seconds/60}}:{key:'automation.manualCheck'};}
 return {key:template.payload.recurrence?'automation.scheduled':'automation.manualStart'};
}

/** The scope of an assignment: its name, and the group path for a group below the root. */
export function assignmentScope(assignment:Pick<AutomationAssignment,'scopeType'|'scopeId'>,groups:readonly AutomationGroup[],servers:readonly Pick<Device,'id'|'name'>[]):{name:string|null;path:string|null}{
 if(assignment.scopeType==='device')return {name:servers.find(s=>s.id===assignment.scopeId)?.name??null,path:null};
 const group=groups.find(g=>g.id===assignment.scopeId);
 return {name:group?.name??null,path:group?.parentId?automationGroupPath(group,groups):null};
}

/** A runbook assignment that runs on a recurrence, one row of the Schedules tab. */
export type AssignmentSchedule={id:string;templateName:string;recurrence:Record<string,unknown>;scope:string;path:string|null;nextDue:number|null;paused:boolean};
/** The enabled or paused runbook assignments whose template has a recurrence, newest first as the API sends them. */
export function assignmentSchedules(data:AutomationData,servers:readonly Pick<Device,'id'|'name'>[],fallback:{group:string;device:string}):AssignmentSchedule[]{
 return data.assignments.flatMap(a=>{
  const template=data.templates.find(entry=>entry.id===a.templateId),recurrence=template?.payload.recurrence;
  if(a.kind!=='runbook'||!recurrence||typeof recurrence!=='object')return [];
  const scope=assignmentScope(a,data.groups,servers);
  return [{id:a.id,templateName:a.templateName,recurrence:recurrence as Record<string,unknown>,scope:scope.name??(a.scopeType==='group'?fallback.group:fallback.device),path:scope.path,nextDue:a.nextDue??null,paused:a.disabled}];
 });
}
