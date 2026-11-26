// Where the signed-in account of this page comes from: 'local' (password and
// portal MFA) or 'entra' (Microsoft Entra ID, docs/entra-id.md). SessionGate
// sets it for the console it guards, so dialogs such as MfaStepUp know it
// without a viewer prop. One page shows one account; a different account means
// a new page load. It only shapes the interface; the server refuses what an
// Entra account cannot do. Plain module state, no hook, so it reads the same in
// every render path.
export type IdentitySource='local'|'entra';
let current:IdentitySource='local';
/** Called by SessionGate with the viewer of the page. */
export function setIdentitySource(value:IdentitySource|undefined){current=value==='entra'?'entra':'local';}
/** The identity source of the signed-in account of this page. */
export const identitySource=():IdentitySource=>current;
