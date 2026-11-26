'use client';
import type {Viewer} from '@/lib/types';
import type {AssistantSettingsView} from '@/lib/server/devices/assistant-settings';
import {AssistantKeyCard,assistantLoadError,useAssistantSettings} from '@/ui/settings/assistant-settings-panel';
import {LoadFailed,Skeleton} from '@/ui/kit/kit';
import {useT} from '@/ui/base/locale';

// The card "AI assistant" on the account page (docs/ai-assistant.md): every
// signed-in user saves, replaces or removes a personal API key that only the
// user's own questions use. API keys only; no step-up, the login session guards
// it. The card shows and changes the real key state, also with sample devices.
export default function PersonalAssistantKey({viewer,initialView=null}:{viewer:Viewer;initialView?:AssistantSettingsView|null}){
 const t=useT();
 const {view,setView,loadFailed,loading,load}=useAssistantSettings(viewer.id,initialView);
 const error=assistantLoadError(loadFailed,!!view,t);
 return <div className="sdx-assistant-personal">
  {error&&<LoadFailed text={error} loading={loading} onRetry={()=>void load()}/>}
  {view?<AssistantKeyCard scope="personal" view={view.personal} onSaved={personal=>setView(previous=>previous&&{...previous,personal})} onStale={()=>void load()}/>
   :!loadFailed&&<Skeleton variant="facts" rows={3} label={t('assistantSettings.loading')}/>}
 </div>;
}
