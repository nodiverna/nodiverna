'use client';
import {Eye,ShieldCheck} from 'lucide-react';
import {agentModeLabel,type AgentMode} from '@/ui/base/agent-mode';
import {PickList,PickRow} from '@/ui/kit/kit';
import {useT} from '@/ui/base/locale';

/** The two agent modes as a radio pick list with the D5 labels "Read-only" and "Management" (the forms of the page Add device). */
export function AgentModePick({value,onChange}:{value:AgentMode;onChange:(mode:AgentMode)=>void}){
 const t=useT();
 return <PickList mode="radio" label={t('agents.enroll.mode')}>
  <PickRow selected={value==='ReadOnly'} icon={<Eye size={15} aria-hidden/>} label={agentModeLabel('ReadOnly',t)} hint={t('addDevice.readOnlyHint')} onSelect={()=>onChange('ReadOnly')}/>
  <PickRow selected={value==='Management'} icon={<ShieldCheck size={15} aria-hidden/>} label={agentModeLabel('Management',t)} hint={t('addDevice.managementHint')} onSelect={()=>onChange('Management')}/>
 </PickList>;
}
