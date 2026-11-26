// The confirmations of the Microsoft Defender actions (docs/device-health-signals.md,
// "Microsoft Defender"): one device in the device area, several devices in the
// scope tab "Protection". Pure, so tests/ui/devices/defender-view.mjs checks the texts and
// payloads without a console render.
import {DEFENDER_BULK_MAX,defenderDeviceNames,type DefenderJobKind} from '@/lib/defender';
import {defenderSkipSentences,type DefenderBulkPlan} from '@/ui/devices/protection/defender-model';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import type {Confirmation} from '@/ui/base/confirmation';
import {crossCustomerHint,crossCustomerLockReason} from '@/ui/base/cross-customer';

/** The button label of each action; the confirm button repeats it. */
export const defenderActionKeys:Record<DefenderJobKind,MessageKey>={'defender-quick-scan':'defender.action.quickScan','defender-full-scan':'defender.action.fullScan','defender-update-signatures':'defender.action.updateSignatures','defender-clean-detections':'defender.action.clean'};
const titleKeys:Record<DefenderJobKind,MessageKey>={'defender-quick-scan':'defender.confirm.quickScan.title','defender-full-scan':'defender.confirm.fullScan.title','defender-update-signatures':'defender.confirm.signatures.title','defender-clean-detections':'defender.confirm.clean.title'};
const bulkTitleKeys:Record<DefenderJobKind,MessageKey>={'defender-quick-scan':'defender.bulk.quickScan.title','defender-full-scan':'defender.bulk.fullScan.title','defender-update-signatures':'defender.bulk.signatures.title','defender-clean-detections':'defender.bulk.clean.title'};
const descriptionKeys:Record<Exclude<DefenderJobKind,'defender-clean-detections'>,MessageKey>={'defender-quick-scan':'defender.confirm.quickScan.description','defender-full-scan':'defender.confirm.fullScan.description','defender-update-signatures':'defender.confirm.signatures.description'};
const actionText=(kind:DefenderJobKind,locale:Locale,activeCount:number)=>kind==='defender-clean-detections'?translate(locale,'defender.confirm.clean.description',{count:activeCount}):translate(locale,descriptionKeys[kind]);

/** One device: the title is a question, the line "Device: {name}" names it, the body says what happens. Clean uses the danger tone. */
export function defenderConfirmation(device:{id:string;name:string;activeCount?:number},kind:DefenderJobKind,locale:Locale=defaultLocale):Confirmation{
 return {
  title:translate(locale,titleKeys[kind]),
  lines:[{label:translate(locale,'defender.confirm.deviceLabel'),value:device.name}],
  description:actionText(kind,locale,device.activeCount??0),
  payload:{action:'job',id:device.id,kind,params:{},confirm:true},
  confirmLabel:translate(locale,defenderActionKeys[kind]),
  tone:kind==='defender-clean-detections'?'danger':'default'
 };
}

/**
 * Several devices: the title counts the eligible devices, the line "Devices"
 * names up to 5 of them, and the body has the action text, one sentence per
 * skip reason and the cross-customer hint.
 * The payload names only the eligible devices.
 */
export function defenderBulkConfirmation(plan:DefenderBulkPlan<{id:string;name:string}>,kind:DefenderJobKind,customers:number,locale:Locale=defaultLocale):Confirmation{
 const count=plan.eligible.length,names=plan.eligible.map(device=>device.name);
 const text=kind==='defender-clean-detections'?translate(locale,'defender.bulk.clean.description'):translate(locale,descriptionKeys[kind]);
 const skips=defenderSkipSentences(plan,locale),hint=crossCustomerHint(customers,locale);
 return {
  title:translate(locale,bulkTitleKeys[kind],{count}),
  lines:[{label:translate(locale,'defender.confirm.devicesLabel'),value:defenderDeviceNames(names,locale)}],
  description:[text,...(skips.length?[skips.join('\n')]:[]),...(hint?[hint]:[])].join('\n\n'),
  payload:{action:'defender-jobs',kind,ids:plan.eligible.map(device=>device.id),confirm:true},
  confirmLabel:translate(locale,defenderActionKeys[kind]),
  tone:kind==='defender-clean-detections'?'danger':'default'
 };
}

/**
 * Why a bulk button is blocked, or undefined: demo, saving, no eligible device,
 * more than 100 selected, then the cross-customer lock, which counts only the
 * customers of the eligible devices.
 */
export function defenderBulkLock(input:{plan:Pick<DefenderBulkPlan<unknown>,'eligible'>;selected:number;customers:number;viewer:{permissions?:string[]};demo:boolean;saving:boolean},locale:Locale=defaultLocale):string|undefined{
 const {plan,selected,customers,viewer,demo,saving}=input;
 if(demo)return translate(locale,'kit.unavailable.demo');
 if(saving)return translate(locale,'fleet.menu.saving');
 if(!plan.eligible.length)return translate(locale,'defender.bulk.noneEligible');
 if(selected>DEFENDER_BULK_MAX)return translate(locale,'fleet.bulk.max');
 return crossCustomerLockReason(viewer,customers,locale)??undefined;
}
