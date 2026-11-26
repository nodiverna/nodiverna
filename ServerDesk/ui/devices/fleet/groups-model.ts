// The pure rules of the device group changes (ui/devices/fleet/groups.tsx, useAccessChange): which change opens
// the MFA step-up dialog before it is sent. No React, so tests import it directly.
import {accessActionNeedsStepUp} from '@/lib/step-up';

/**
 * Whether an access change opens the MFA dialog before it is sent: the actions that always ask
 * (accessActionNeedsStepUp), and delete-group when the group's stepUpOnDelete is true.
 */
export function accessRequestNeedsStepUp({body,stepUpOnDelete}:{body:Record<string,unknown>;stepUpOnDelete?:boolean}):boolean{
 return accessActionNeedsStepUp(body.action)||body.action==='delete-group'&&stepUpOnDelete===true;
}
