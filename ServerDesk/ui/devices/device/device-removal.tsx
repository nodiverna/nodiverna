'use client';
import type {Server,Viewer} from '@/lib/types';
import type {Device} from '@/ui/base/api';
import {isOwner} from '@/ui/base/access-capabilities';
import type {Confirmation} from '@/ui/base/confirmation';
import type {UninstallChoice} from '@/ui/base/confirmation';
import {canUninstall} from '@/lib/offboarding';
import {deviceConnection} from '@/ui/base/ui-device';
import {ApiError} from '@/ui/base/http';
import {opensMfaPrompt} from '@/lib/errors/codes';
import {isDeviceRemovalAction} from '@/lib/step-up';
import {missingProofMessage,stepUpRetry,type StepUpProof} from '@/ui/session/step-up-retry';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import {useT} from '@/ui/base/locale';
import {Field} from '@/ui/kit/field';

// Removing devices is irreversible, so it needs a fresh MFA step-up proof
// (lib/step-up.ts). Both consoles ask for it right after the confirmation,
// before anything is sent, and the server enforces it either way.
export {missingProofMessage,stepUpRetry,type StepUpProof};
/** Whether this console payload removes devices and has no proof yet, so the step-up dialog opens first. */
export const removalNeedsStepUp=(payload:Record<string,unknown>)=>isDeviceRemovalAction(payload.action)&&typeof payload.managementToken!=='string';
/** Whether a failed request opens the step-up dialog (by code, never by message text). */
export const stepUpRejected=(failure:unknown)=>failure instanceof ApiError&&opensMfaPrompt(failure.code);
/** Whether a failed removal opens the step-up dialog again. */
export const removalProofRejected=stepUpRejected;
/**
 * The callback the step-up dialog runs after verification: it sends the removal
 * payload once with the new proof. Without a proof it only reports the problem.
 */
export const removalProofRetry=(payload:Record<string,unknown>,send:(payload:Record<string,unknown>)=>Promise<void>|void,report:(message:string)=>void,locale:Locale=defaultLocale)=>stepUpRetry(payload,send,report,locale);

// The removal dialog can also ask the agent to uninstall itself (job
// agent-uninstall). The device leaves the portal only after its agent confirms
// the start; lib/offboarding.ts holds the shared rules.
type RemovalDevice=Pick<Device,'id'|'name'>&Partial<Pick<Device,'lastSeen'|'snapshot'|'maintenance'|'registration'>>;
/** What the console knows about the uninstall: its clock and the devices with an open uninstall job. */
export type RemovalContext={now?:number;pending?:ReadonlySet<string>};
export type UninstallReadiness='ready'|'offline'|'unsupported'|'pending';
/** Whether a device can uninstall its agent now, by capability, open job and the console's online rule. */
export function uninstallReadiness(server:RemovalDevice,{now=Date.now(),pending}:RemovalContext={}):UninstallReadiness{
 if(pending?.has(server.id))return 'pending';
 if(!canUninstall(server.snapshot))return 'unsupported';
 return deviceConnection(server as Server,now).kind==='online'?'ready':'offline';
}
const uninstallHints:Record<UninstallReadiness,MessageKey>={ready:'console.removal.uninstall.hintReady',offline:'console.removal.uninstall.hintOffline',unsupported:'console.removal.uninstall.hintUnsupported',pending:'console.removal.uninstall.hintPending'};

export function deviceRemovalConfirmation(server:RemovalDevice,locale:Locale=defaultLocale,context:RemovalContext={}):Confirmation{
 const readiness=uninstallReadiness(server,context),available=readiness==='ready'||readiness==='offline';
 return {
  title:translate(locale,'console.removal.title',{name:server.name}),
  description:translate(locale,'console.removal.description'),
  confirmLabel:translate(locale,'console.removal.button'),
  tone:'danger',
  lines:[{label:translate(locale,'console.removal.deviceLabel'),value:server.name}],
  payload:{action:'remove-server',id:server.id,confirm:true},
  uninstall:{available,checked:readiness==='ready',hint:translate(locale,uninstallHints[readiness]),title:translate(locale,'console.removal.uninstallTitle',{name:server.name}),description:translate(locale,'console.removal.uninstallDescription'),confirmLabel:translate(locale,'console.removal.uninstallButton')}
 };
}

export const canRemoveDevices=(viewer:Viewer)=>isOwner(viewer);

export function bulkDeviceRemovalConfirmation(servers:readonly RemovalDevice[],locale:Locale=defaultLocale,context:RemovalContext={}):Confirmation{
 const selected=[...new Map(servers.map(server=>[server.id,server])).values()];
 if(!selected.length||selected.length>100)throw new Error(translate(locale,'console.removal.selectRange'));
 // The names are the dialog's "Devices" fact, not part of the description.
 return {
  title:translate(locale,'console.removal.bulkTitle',{count:selected.length}),
  description:translate(locale,'console.removal.bulkDescription'),
  confirmLabel:translate(locale,'console.removal.bulkButton',{count:selected.length}),
  tone:'danger',
  lines:[{label:translate(locale,'console.removal.devicesLabel'),value:selected.map(server=>server.name).join(', ')}],
  payload:{action:'remove-servers',ids:selected.map(server=>server.id),confirm:true},
  uninstall:{...bulkUninstallChoice(selected.map(server=>uninstallReadiness(server,context)),locale),title:translate(locale,'console.removal.uninstallBulkTitle',{count:selected.length}),description:translate(locale,'console.removal.uninstallBulkDescription'),confirmLabel:translate(locale,'console.removal.uninstallButton')}
 };
}
// Preselected only when every device can uninstall now, so the default never
// leaves devices registered without a word; available when one device can.
function bulkUninstallChoice(states:UninstallReadiness[],locale:Locale):Pick<UninstallChoice,'available'|'checked'|'hint'>{
 const ready=states.filter(state=>state==='ready').length,capable=states.filter(state=>state==='ready'||state==='offline').length;
 if(ready===states.length)return {available:true,checked:true,hint:translate(locale,'console.removal.uninstall.hintReady')};
 if(!capable)return {available:false,checked:false,hint:translate(locale,states.every(state=>state==='pending')?'console.removal.uninstall.hintPending':'console.removal.uninstall.hintUnsupported')};
 return {available:true,checked:false,hint:translate(locale,'console.removal.uninstall.hintBulkPartial',{ready,count:states.length})};
}

/** The switch row of the removal dialog: on asks the agent to uninstall itself first. The hint (the reason of an unavailable switch) stays visible below it. */
export function UninstallSwitch({choice,checked,onChange}:{choice:UninstallChoice;checked:boolean;onChange:(checked:boolean)=>void}){
 const t=useT();
 return <Field inline label={t('console.removal.uninstall.label')} hint={choice.hint} className="sdx-uninstall-choice">
  <input type="checkbox" role="switch" checked={choice.available&&checked} disabled={!choice.available} onChange={event=>onChange(event.target.checked)}/>
 </Field>;
}

