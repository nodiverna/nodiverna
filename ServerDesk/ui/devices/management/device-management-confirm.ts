// The classic management actions of the Management panels System, Network (Firewall rules) and Scheduled tasks: the
// blocked reason (ui/devices/management/management-actions.ts, plus a running save) and the confirmation with its review lines.
import type {Viewer} from '@/lib/types';
import {deviceConnection} from '@/ui/base/ui-device';
import {confirmationDevice,managementActionReason,managementMode,managementReview} from '@/ui/devices/management/management-actions';
import type {Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import {permitted,type Device} from '@/ui/base/api';
import type {Confirmation} from '@/ui/base/confirmation';

export type ManagementPanelProps={server:Device;viewer:Viewer;demo:boolean;saving:boolean;onConfirm:(confirmation:Confirmation)=>void;now:number};
/** The confirmation titles of the classic management actions. */
export const managementActionTitles:Readonly<Record<string,MessageKey>>={'rename-computer':'management.action.renameComputer','join-domain':'management.action.joinDomain','leave-domain':'management.action.leaveDomain','add-firewall-rule':'management.action.addFirewallRule','set-firewall-rule':'management.action.setFirewallRule','set-task':'management.action.setTask'};

/** Why a classic management action is blocked on this panel, or '': the rules of managementActionReason, then a running save. */
export function panelManageReason(props:Omit<ManagementPanelProps,'onConfirm'>,kind:string,locale:Locale):string{
 const {server,viewer,demo,now,saving}=props,snapshot=server.snapshot;
 return managementActionReason({demo,canOperate:permitted(server,viewer,'manage'),canDiagnose:permitted(server,viewer,'diagnose'),offline:deviceConnection(server,now).kind!=='online',capabilities:snapshot?.agentCapabilities,domainRole:snapshot?.security?.domainRole,management:managementMode(server)},kind,locale)||(saving?translate(locale,'services.blocked.saving'):'');
}

/**
 * Asks the console to confirm a classic management action on the live panel props: nothing happens when the panel
 * shows another device now or the action is blocked. The description starts with the review lines of the change.
 */
export function confirmManagementAction(current:ManagementPanelProps,expectedServer:string,kind:string,params:Record<string,unknown>,description:string,confirmLabel:string,locale:Locale,tone?:'danger'){
 if(current.server.id!==expectedServer||panelManageReason(current,kind,locale))return;
 current.onConfirm({title:translate(locale,managementActionTitles[kind])+'?',description:`${managementReview(kind,params,current.server.snapshot,locale)}\n\n${description}`,lines:confirmationDevice(current.server.name,locale),confirmLabel,...(tone?{tone}:{}),payload:{action:'job',id:current.server.id,kind,params,confirm:true}});
}
