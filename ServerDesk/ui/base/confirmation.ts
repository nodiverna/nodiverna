// The uninstall switch of a removal confirmation. title, description and
// confirmLabel replace the confirmation's own while the switch is on; hint
// explains the state and stays visible below the switch.
export type UninstallChoice={available:boolean;checked:boolean;hint:string;title:string;description:string;confirmLabel:string};
/** How a confirmed action ended: ok with the new job ID when the server answers one, or the error code (undefined without a code), the shown error text and the field errors of the refusal (POST /api/dhcp changeInvalid). */
export type ConfirmationOutcome={ok:true;id?:string}|{ok:false;code?:string;message?:string;errors?:unknown};
/** A fact the dialog shows above its description, for example "Device: SRV-01". */
export type ConfirmationLine={label:string;value:string;
 /** The value in the mono face (an account, an address). */
 mono?:boolean};
// A pending action that waits for the user's confirmation in a dialog. onSettled
// runs once the confirmed request ended (after a step-up retry, with its answer).
// confirmLabel is the verb of the confirm button, the same action as the trigger
// and the title ("Remove device", never "Confirm"; required), tone picks the kit danger or primary button, lines are Facts.
// endpoint: the route of the payload (default /api/console; /api/assistant runs an
// assistant command, /api/dhcp a DHCP change, /api/dns a DNS change); stepUpFirst opens the
// step-up dialog before anything is sent (lib/step-up.ts); success is the toast
// text of a success. plugin names the plugin of a change (/api/dhcp: dhcp, /api/dns: dns), so a
// PLUGIN_AD_SIGN_IN_REQUIRED answer opens the AD sign-in for it (docs/plugin-ad-sign-in.md).
export type Confirmation={title:string;description:string;payload:Record<string,unknown>;confirmLabel:string;tone?:'danger'|'default';lines?:ConfirmationLine[];uninstall?:UninstallChoice;onSettled?:(outcome:ConfirmationOutcome)=>void;endpoint?:'/api/plugins'|'/api/assistant'|'/api/dhcp'|'/api/dns';plugin?:string;stepUpFirst?:boolean;success?:string};
/** The send options of a confirmation for the console action. */
export const confirmationOptions=(confirmation:Pick<Confirmation,'endpoint'|'plugin'|'stepUpFirst'|'success'>|null|undefined)=>({endpoint:confirmation?.endpoint,plugin:confirmation?.plugin,stepUpFirst:confirmation?.stepUpFirst,success:confirmation?.success});
/** What the dialog shows and sends: with an uninstall switch the payload carries uninstall:true|false, and the uninstall title, description and label while it is on. */
export function confirmedView(confirmation:Confirmation,uninstallOn:boolean){
 const {lines,tone}=confirmation;
 if(!confirmation.uninstall)return {title:confirmation.title,description:confirmation.description,confirmLabel:confirmation.confirmLabel,lines,tone,payload:confirmation.payload};
 const on=confirmation.uninstall.available&&uninstallOn;
 return {title:on?confirmation.uninstall.title:confirmation.title,description:on?confirmation.uninstall.description:confirmation.description,confirmLabel:on?confirmation.uninstall.confirmLabel:confirmation.confirmLabel,lines,tone,payload:{...confirmation.payload,uninstall:on}};
}
