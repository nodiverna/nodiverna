// The update rules of the device page and the fleet update view: whether a viewer may see the
// agent updates of a device, and why an update cannot start. This is UI code: the client shapes the
// interface with isOwner (ui/base/access-capabilities.ts); the server decides through
// lib/server/identity/policy/can.ts.
import type {Server,Viewer} from '@/lib/types';
import {translate} from '@/lib/i18n/translate';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {isOwner} from '@/ui/base/access-capabilities';
export function inspectDeviceUpdates(server:Server&{permissions?:string[]},viewer:Viewer,demo=false){return !demo&&(isOwner(viewer)||server.permissions?.includes('update')===true);}
export function deviceUpdateBlockReason(server:Server&{permissions?:string[]},viewer:Viewer,online:boolean,demo=false,locale:Locale=defaultLocale){
 if(!inspectDeviceUpdates(server,viewer,demo))return demo?translate(locale,'services.blocked.demo'):translate(locale,'agentUpdates.blocked.right');
 if(server.management!==1||server.snapshot?.mode!=='Management')return translate(locale,'agentUpdates.blocked.readOnly');
 if(!online)return translate(locale,'agentUpdates.blocked.offline');
 if(server.snapshot?.protocolVersion!==3||!server.snapshot.agentCapabilities?.includes('agent-update'))return translate(locale,'agentUpdates.blocked.unsupported');
 return '';
}
