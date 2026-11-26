'use client';
// Loads the alarm week of the Dashboard heatmap (GET /api/dashboard, lib/server/dashboard-data.ts): on mount, again
// whenever `revision` changes (the console refresh, a new hour, a change of the open alarms) and on retry. A reload
// keeps the counts it has; a failed load keeps them too and reports the failure. Sample devices call no API: their
// week is demoAlarmWeek, a fixed pattern.
import {useCallback,useEffect,useMemo,useState} from 'react';
import {credentialFetch,message,readApiJson} from '@/ui/base/api';
import {demoAlarmWeek,type AlarmWeek} from '@/ui/devices/dashboard/dashboard-model';

/** The alarm week as the tile reads it: the counts once loaded, the text of a failed load, and the retry. */
export type AlarmWeekState={week:AlarmWeek|null;error:string;loading:boolean;retry:()=>void};

/** GET /api/dashboard: the hourly alarm counts of the visible devices. */
export async function loadAlarmWeek():Promise<AlarmWeek>{
 const response=await credentialFetch('/api/dashboard',{cache:'no-store'});
 const {alarmWeek}=await readApiJson<{alarmWeek?:{start?:unknown;hours?:unknown}}>(response);
 return {start:Number(alarmWeek?.start)||0,hours:Array.isArray(alarmWeek?.hours)?alarmWeek.hours.map(count=>Math.max(0,Number(count)||0)):[]};
}

export function useAlarmWeek({demo,enabled=true,revision,now,load=loadAlarmWeek}:{demo:boolean;
 /** false while the tile is hidden: nothing loads. */
 enabled?:boolean;revision:unknown;
 /** The time of the sample week (the console clock's hour). */
 now:number;load?:()=>Promise<AlarmWeek>}):AlarmWeekState{
 const [attempt,setAttempt]=useState(0),[result,setResult]=useState<{week:AlarmWeek|null;error:string;key:string}>({week:null,error:'',key:''});
 const key=`${attempt}:${String(revision)}`;
 useEffect(()=>{
  if(demo||!enabled)return;
  let current=true;
  void load().then(
   week=>{if(current)setResult({week,error:'',key});},
   failure=>{if(current)setResult(previous=>({week:previous.week,error:message(failure),key}));});
  return ()=>{current=false;};
 },[demo,enabled,key,load]);
 const retry=useCallback(()=>setAttempt(count=>count+1),[]);
 const sample=useMemo(()=>demo?demoAlarmWeek(now):null,[demo,now]);
 if(sample)return {week:sample,error:'',loading:false,retry};
 return {week:result.week,error:result.error,loading:result.key!==key,retry};
}
