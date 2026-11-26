'use client';
// The layout state of the Dashboard page (docs/dashboard.md): which layout the page shows, and the draft of the edit
// mode. The page shows the draft while the edit mode is on; Save sends it to the server (the account's own layout,
// or the default layout in the Owner's mode) and hands the answer to the console, Cancel drops it. beforeChange runs
// right before the shown layout changes, so the widgets can move softly (useFlip).
import {useState} from 'react';
import type {DashboardLayout,DashboardPreference} from '@/lib/dashboard-layout';
import {credentialFetch,readApiJson} from '@/ui/base/api';
import {layoutDirty,layoutSaveValue,shownDashboardLayout,startLayoutEdit,type LayoutEdit,type LayoutMode} from '@/ui/devices/dashboard/dashboard-model';

/** PUT /api/account/dashboard (own) or PUT /api/dashboard/default (default): stores the layout, null for none. Resolves with the stored preference. */
export async function saveDashboardLayout(mode:LayoutMode,layout:DashboardLayout|null):Promise<DashboardPreference>{
 const response=await credentialFetch(mode==='own'?'/api/account/dashboard':'/api/dashboard/default',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({layout}),cache:'no-store'});
 return (await readApiJson<{dashboard:DashboardPreference}>(response)).dashboard;
}

export type DashboardLayoutOptions={
 preference:DashboardPreference;
 /** The stored preference after a save: the console keeps it until its next load carries the same. */
 onSaved:(next:DashboardPreference)=>void;
 /** Feedback of a save: the mode that was saved, or the failure. */
 done:(mode:LayoutMode)=>void;failed:(failure:unknown)=>void;
 beforeChange?:()=>void;
 save?:typeof saveDashboardLayout;
};

export function useDashboardLayout({preference,onSaved,done,failed,beforeChange,save=saveDashboardLayout}:DashboardLayoutOptions){
 const [edit,setEdit]=useState<LayoutEdit|null>(null),[saving,setSaving]=useState(false);
 const start=(mode:LayoutMode)=>{beforeChange?.();setEdit(startLayoutEdit(mode,preference));};
 const change=(next:LayoutEdit)=>{beforeChange?.();setEdit(next);};
 const cancel=()=>{beforeChange?.();setEdit(null);};
 const submit=async()=>{
  if(!edit||saving||!layoutDirty(edit,preference))return;
  setSaving(true);
  try{
   const stored=await save(edit.mode,layoutSaveValue(edit,preference));
   onSaved(stored);done(edit.mode);
   setEdit(null);
  }catch(failure){failed(failure);}
  finally{setSaving(false);}
 };
 return {
  /** The layout the page shows now. */
  layout:shownDashboardLayout(preference,edit),
  /** The draft while the edit mode is on, else null. */
  edit,
  dirty:!!edit&&layoutDirty(edit,preference),saving,start,change,cancel,submit,
 };
}
