// Shared by Settings → Notifications (ui/settings/notifications-panel.tsx) and the scope tab Notification rules
// (ui/devices/monitoring/notification-rules.tsx): the channel type names and icons, and the field marks that decide
// when a form error shows. Kept apart so the scope view does not load the settings page module.
import {Mail,MessageCircle,MessagesSquare,Webhook} from 'lucide-react';
import type {ChannelType} from '@/lib/server/notifications/notify/send';
import type {MessageKey} from '@/lib/i18n/translate';

export const channelTypeKeys:Record<ChannelType,MessageKey>={smtp:'notifications.type.smtp',teams:'notifications.type.teams',discord:'notifications.type.discord',webhook:'notifications.type.webhook'};
export const channelTypeIcons={smtp:Mail,teams:MessagesSquare,discord:MessageCircle,webhook:Webhook} as const;

/**
 * The field errors to show: those of fields the user changed and then left
 * (`shown`), and all of them after a submit. A shown error goes away as soon as
 * the field is valid, because `errors` is computed from the current values.
 */
export function shownErrors<F extends string>(errors:Partial<Record<F,MessageKey>>,shown:ReadonlySet<F>,submitted:boolean):Partial<Record<F,MessageKey>>{
 return Object.fromEntries(Object.entries(errors).filter(([field])=>submitted||shown.has(field as F))) as Partial<Record<F,MessageKey>>;
}
/** Why Save is blocked: "Fill in the required fields first." while no error shows, "Correct the marked fields first." once one does; null while the form is valid. */
export function saveBlockedKey(errors:Partial<Record<string,MessageKey>>,visible:Partial<Record<string,MessageKey>>):MessageKey|null{
 if(!Object.keys(errors).length)return null;
 return Object.keys(visible).length?'alertRules.blocked.invalid':'notifications.blocked.incomplete';
}

/** Which fields the user changed and which show their error. */
export type FieldMarks<F extends string>={changed:ReadonlySet<F>;shown:ReadonlySet<F>};
/** The user changed these fields: their errors do not show yet. */
export function markChanged<F extends string>(marks:FieldMarks<F>,fields:readonly F[]):FieldMarks<F>{
 return fields.every(field=>marks.changed.has(field))?marks:{...marks,changed:new Set([...marks.changed,...fields])};
}
/** The user left a field: once it was changed, its error shows from now on. An untouched field stays quiet. */
export function markLeft<F extends string>(marks:FieldMarks<F>,field:F):FieldMarks<F>{
 return marks.changed.has(field)&&!marks.shown.has(field)?{...marks,shown:new Set([...marks.shown,field])}:marks;
}
/** These fields show their error at once (a choice that can make them invalid). */
export function markShown<F extends string>(marks:FieldMarks<F>,fields:readonly F[]):FieldMarks<F>{
 return fields.every(field=>marks.shown.has(field))?marks:{...marks,shown:new Set([...marks.shown,...fields])};
}
