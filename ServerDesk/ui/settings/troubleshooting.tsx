'use client';
// Settings → Agent troubleshooting in the redesigned console. Starts with the devices
// that currently need attention (the focal point), then walks through the checks in
// the order an administrator should run them, the further tools, and last the
// uninstall guide. Command strings come from agent-guide.ts so the downloadable
// guide and this page stay identical.
import {consoleRouteHash} from '@/lib/console-route';
import {useRef,useState,useSyncExternalStore,type ReactNode} from 'react';
import {CheckCircle2,ListChecks,MonitorSmartphone,Terminal,Trash2,TriangleAlert,WifiOff,Wrench} from 'lucide-react';
import {deviceConnection} from '@/ui/base/ui-device';
import {agentCacheCommand,agentConnectivityCommand,agentCrashEventsCommand,portalOriginServerSnapshot,portalOriginSnapshot,subscribePortalOrigin,agentHealthCommand,agentInstallCommand,agentLogsCommand,agentRepairCommand,agentRestartCommand,agentStartCommand,agentStatusCommand,agentStopCommand,agentUninstallCommand} from '@/ui/devices/add-device/agent-guide';
import type {Device} from '@/ui/base/api';
import {Btn,Card,CommandBlock,Disclosure,Empty,Notice,RichText as Rich,SettingsPage,StatusPill,Steps,connectionPillKind,exactTime,relativeTime} from '@/ui/kit/kit';
import {frameHeader,type PageFrame} from '@/ui/shell/page-frame';
import '@/ui/settings/troubleshooting.css';

import {useLocale,useT} from '@/ui/base/locale';
import {useClockNow} from '@/ui/base/clock-store';
const visibleDevices=6;
const kindOrder={offline:0,waiting:1,maintenance:2,online:3} as const;
/** The add-device page (#devices/add): the step links lead there. */
const addDeviceHash=consoleRouteHash({view:'add-device'});

type Props={servers:Device[];
 /** Pins the time (tests); without it the page follows the console clock every second. */
 now?:number;onOpenDevice:(id:string)=>void;
 /** The console frame (ui/shell/page-frame.ts): the page header at the top of the page. */
 frame?:PageFrame};

export default function AgentTroubleshootingPage({servers,now:pinnedNow,onOpenDevice,frame}:Props){
 const now=useClockNow(pinnedNow);
 const t=useT();
 const portalOrigin=useSyncExternalStore(subscribePortalOrigin,portalOriginSnapshot,portalOriginServerSnapshot);
 const [toolsOpen,setToolsOpen]=useState(false);
 const tools=useRef<HTMLDetailsElement>(null);
 const openTools=()=>{
  setToolsOpen(true);
  const reduce=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  requestAnimationFrame(()=>tools.current?.scrollIntoView({behavior:reduce?'auto':'smooth',block:'start'}));
 };

 // One SettingsPage like every settings page: the guide is wide content, so it starts at the same left inset.
 return <>{frameHeader(frame)}<SettingsPage label={t('nav.settings.agentTroubleshooting')} wide={<div className="sdx-ts">
  <Notice tone="info" icon={Terminal}><Rich text={t('troubleshooting.intro')} parts={{path:<code>%ProgramData%\ServerDesk</code>}}/></Notice>

  <SilentDevices servers={servers} now={now} onOpenDevice={onOpenDevice}/>

  <Card title={t('troubleshooting.steps')} icon={ListChecks} iconTone="accent" id="sdx-ts-steps-title" meta={t('troubleshooting.stepsMeta')}>
   <Steps items={[
    {id:'services',title:t('troubleshooting.services.title'),children:<StepBody check={<Rich text={t('troubleshooting.services.check')} parts={{agent:<code>ServerDeskAgent</code>,worker:<code>ServerDeskWorker</code>}}/>}
     commands={[{command:agentStatusCommand}]}
     result={<Rich text={t('troubleshooting.services.result')} parts={{running:<code>Running</code>,stopped:<code>Stopped</code>,start:<button type="button" className="sdx-ts-link" onClick={openTools}>{t('troubleshooting.services.start')}</button>}}/>}/>},
    {id:'portal',title:t('troubleshooting.portal.title'),children:<StepBody check={t('troubleshooting.portal.check')}
     commands={[{command:agentConnectivityCommand(portalOrigin)}]}
     result={<Rich text={t('troubleshooting.portal.result')} parts={{status:<code>StatusCode 200</code>}}/>}/>},
    {id:'reports',title:t('troubleshooting.reports.title'),children:<StepBody check={t('troubleshooting.reports.check')}
     commands={[{label:t('troubleshooting.reports.health'),command:agentHealthCommand},{label:t('troubleshooting.reports.log'),command:agentLogsCommand}]}
     result={<Rich text={t('troubleshooting.reports.result')} parts={{at:<code>at</code>,version:<code>version</code>,heartbeat:<code>Heartbeat:</code>,channel:<code>Channel:</code>,log:<code>%ProgramData%\ServerDesk\agent-v3.log</code>}}/>}/>},
    {id:'repair',title:t('troubleshooting.repair.title'),children:<StepBody check={t('troubleshooting.repair.check')}
     commands={[{label:t('troubleshooting.repair.repair'),command:agentRepairCommand},{label:t('troubleshooting.repair.register'),command:agentUninstallCommand+'\n'+agentInstallCommand(t('agents.install.registrationFile'))}]}
     result={<Rich text={t('troubleshooting.repair.result')} parts={{path:<code>%ProgramData%\ServerDesk</code>,add:<a href={addDeviceHash}>{t('tree.addDevice')}</a>}}/>}/>},
   ]}/>
  </Card>

  <Disclosure ref={tools} icon={Wrench} title={t('troubleshooting.tools')} hint={t('troubleshooting.toolsHint')} open={toolsOpen} onOpenChange={setToolsOpen}>
    <section className="sdx-ts-tool" aria-labelledby="sdx-ts-services">
     <h3 id="sdx-ts-services">{t('troubleshooting.servicesTitle')}</h3>
     <p>{t('troubleshooting.servicesHint')}</p>
     <CommandBlock label={t('services.action.start')} command={agentStartCommand}/>
     <CommandBlock label={t('services.action.restart')} command={agentRestartCommand}/>
     <CommandBlock label={t('services.action.stop')} command={agentStopCommand}/>
    </section>
    <section className="sdx-ts-tool" aria-labelledby="sdx-ts-crashes">
     <h3 id="sdx-ts-crashes">{t('troubleshooting.crashes')}</h3>
     <p>{t('troubleshooting.crashesHint')}</p>
     <CommandBlock command={agentCrashEventsCommand}/>
    </section>
    <section className="sdx-ts-tool" aria-labelledby="sdx-ts-cache">
     <h3 id="sdx-ts-cache">{t('troubleshooting.cache.title')}</h3>
     <p><Rich text={t('troubleshooting.cache.text')} parts={{runtime:<code>runtime</code>,workerRuntime:<code>worker\runtime</code>}}/></p>
     <Notice tone="warning" icon={TriangleAlert}><Rich text={t('troubleshooting.cache.warning')} parts={{path:<code>%ProgramData%\ServerDesk</code>,config:<code>config.bin</code>,worker:<code>worker.bin</code>,current:<code>current</code>,previous:<code>previous</code>,updates:<code>updates</code>,transfers:<code>transfers</code>}}/></Notice>
     <CommandBlock command={agentCacheCommand} tall/>
    </section>
  </Disclosure>

  <AgentUninstallCard/>
 </div>}/></>;
}

/** The last section: how to uninstall the agent, in three steps with the uninstall command and its copy button. */
export function AgentUninstallCard(){
 const t=useT();
 return <Card title={t('agents.uninstall.title')} icon={Trash2} iconTone="neutral" id="sdx-ts-uninstall-title">
  <Steps label={t('agents.uninstall.title')} items={[
   {id:'end',title:t('agents.uninstall.step1'),children:<p className="sdx-ts-check">{t('agents.uninstall.step1Hint')}</p>},
   {id:'local',title:t('agents.uninstall.step2'),children:<>
    <p className="sdx-ts-check"><Rich text={t('agents.uninstall.local')} parts={{exe:<a href={addDeviceHash}>{t('agents.uninstall.downloadedExe')}</a>}}/></p>
    <CommandBlock command={agentUninstallCommand}/>
    <p className="sdx-ts-result">{t('agents.uninstall.removes')}</p>
   </>},
   {id:'portal',title:t('agents.uninstall.step3'),children:<p className="sdx-ts-check">{t('agents.uninstall.step3Hint')}</p>},
  ]}/>
 </Card>;
}

function SilentDevices({servers,now,onOpenDevice}:Props&{now:number}){
 const t=useT(),[locale]=useLocale();
 const [expanded,setExpanded]=useState(false);
 const silent=servers
  .map(server=>({server,connection:deviceConnection(server,now,locale)}))
  .filter(entry=>entry.connection.kind!=='online')
  .sort((a,b)=>kindOrder[a.connection.kind]-kindOrder[b.connection.kind]||(b.server.lastSeen??0)-(a.server.lastSeen??0)||a.server.name.localeCompare(b.server.name,'de'));
 const shown=expanded?silent:silent.slice(0,visibleDevices);
 const meta=servers.length===0?undefined:silent.length===0?undefined:t('fleet.foot',{shown:silent.length,count:servers.length});
 return <Card title={t('troubleshooting.silent.title')} icon={WifiOff} iconTone={servers.length===0?'neutral':silent.length?'warning':'success'} id="sdx-ts-silent-title" meta={meta} flush>
  {servers.length===0
   ?<Empty icon={MonitorSmartphone} title={t('troubleshooting.silent.none')}><Rich text={t('troubleshooting.silent.noneHint')} parts={{add:<a href={addDeviceHash}>{t('tree.addDevice')}</a>}}/></Empty>
   :silent.length===0
    ?<div className="sdx-ts-ok"><Empty icon={CheckCircle2} title={t('troubleshooting.silent.allTitle')}>{t('troubleshooting.silent.allReport',{count:servers.length})}</Empty></div>
    :<>
     <ul className="sdx-ts-devices">
      {shown.map(({server,connection})=><li key={server.id}>
       <div className="sdx-ts-device-text">
        <strong>{server.name}</strong>
        <span title={server.lastSeen?exactTime(server.lastSeen,locale):undefined}>{server.lastSeen?t('troubleshooting.silent.lastReport',{time:relativeTime(server.lastSeen,now,locale)}):t('device.overview.noReport')}{server.groupName?` · ${server.groupName}`:''}</span>
       </div>
       <StatusPill kind={connectionPillKind(connection.kind)}>{connection.label}</StatusPill>
       <Btn size="sm" variant="ghost" aria-label={t('fleet.openDevice',{name:server.name})} onClick={()=>onOpenDevice(server.id)}>{t('common.open')}</Btn>
      </li>)}
     </ul>
     {silent.length>visibleDevices&&<div className="sdx-ts-devices-more"><Btn size="sm" variant="ghost" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>{expanded?t('troubleshooting.silent.less'):t('troubleshooting.silent.all',{length:silent.length})}</Btn></div>}
    </>}
 </Card>;
}

/** The body of one diagnosis step: what to check, the commands and the expected result. */
function StepBody({check,commands,result}:{check:ReactNode;commands:{label?:string;command:string}[];result:ReactNode}){
 const t=useT();
 return <>
  <p className="sdx-ts-check">{check}</p>
  {commands.map(item=><CommandBlock key={item.label??item.command} label={item.label} command={item.command}/>)}
  <p className="sdx-ts-result"><strong>{t('troubleshooting.result')}</strong> {result}</p>
 </>;
}
