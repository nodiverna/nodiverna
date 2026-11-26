'use client';
import {Hourglass,RefreshCw,WifiOff} from 'lucide-react';
import type {Server as Device} from '@/lib/types';
import {deviceConnection} from '@/ui/base/ui-device';
import {translate} from '@/lib/i18n/translate';
import type {Locale} from '@/lib/i18n/locale';
import {Notice,exactTime} from '@/ui/kit/kit';

import {useLocale} from '@/ui/base/locale';
export type DeviceState={tone:'warning'|'info';icon:typeof WifiOff;text:string};
/**
 * The state notice of a device that does not report live values, by deviceConnection().kind:
 * offline (with or without an inventory), never reported (waiting) and agent update (maintenance).
 * null for an online device.
 */
export function deviceState(server:Pick<Device,'snapshot'|'lastSeen'|'maintenance'|'registration'>,now:number,locale:Locale):DeviceState|null{
 const kind=deviceConnection(server as Device,now,locale).kind;
 if(kind==='offline')return server.snapshot
  ?{tone:'warning',icon:WifiOff,text:translate(locale,'device.state.offline',{exactTime:exactTime(server.lastSeen,locale)})}
  :{tone:'warning',icon:WifiOff,text:translate(locale,'device.state.offlineNoInventory')};
 if(kind==='waiting')return {tone:'info',icon:Hourglass,text:translate(locale,'device.neverReported')};
 if(kind==='maintenance')return {tone:'info',icon:RefreshCw,text:translate(locale,'device.summary.updating')};
 return null;
}

/** One notice for every device area: DeviceView renders it once at the top of the area body. */
export function DeviceStateNotice({server,now}:{server:Pick<Device,'snapshot'|'lastSeen'|'maintenance'|'registration'>;now:number}){
 const [locale]=useLocale(),state=deviceState(server,now,locale);
 return state?<Notice tone={state.tone} icon={state.icon}>{state.text}</Notice>:null;
}
