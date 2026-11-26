'use client';
// "Move to another customer…" (docs/customers.md "Move devices to another customer"): the drawer is the confirmation.
// Its focal point is the "from → to" customer line; below it the target customer, the target group of that customer,
// and two cards that say what stays with the device and what ends. The primary names the action and sends the move
// through useStepUp, which asks for MFA first (lib/step-up.ts, rule 1). The console hosts it (ui/shell/console.tsx).
import {useState} from 'react';
import {ArrowRight,CircleSlash,Folder,Layers,ShieldCheck} from 'lucide-react';
import {toast} from 'sonner';
import type {BrandingLogoPair} from '@/lib/branding';
import type {DeviceGroup,Viewer} from '@/lib/types';
import {api,type Device} from '@/ui/base/api';
import {useLocale,useT} from '@/ui/base/locale';
import {useStepUp} from '@/ui/session/step-up-retry';
import {MfaStepUp} from '@/ui/session/mfa-step-up';
import {Btn,Card,Drawer,DrawerCancel,Empty,Facts,PickList,PickRow} from '@/ui/kit/kit';
import {Field,Select} from '@/ui/kit/field';
import {CustomerAvatar} from '@/ui/devices/fleet/customer-avatar';
import {customerMoveDone,customerMoveGroups,customerMovePayload,customerMoveTargets,customerMoveUngrouped,type MoveCustomer} from '@/ui/devices/fleet/customer-move-model';
import '@/ui/devices/fleet/customer-move-drawer.css';

type MovePayload=ReturnType<typeof customerMovePayload>;
type MoveResult={ok:true;ids:string[];customerId:string;groupId:string|null};

/** One end of the "from → to" line: the customer avatar and name; the placeholder in muted text until a customer is chosen. */
function RouteEnd({name,logo,placeholder}:{name?:string;logo?:BrandingLogoPair|null;placeholder?:string}){
 if(!name)return <span className="sdx-customer-move-end sdx-muted-cell">{placeholder}</span>;
 return <span className="sdx-customer-move-end"><CustomerAvatar name={name} logo={logo}/><strong>{name}</strong></span>;
}

/**
 * Moves the devices to another customer. customers are the active customers the viewer sees (ConsoleData.customers),
 * logos the customer logos (ConsoleData.branding.customers). onMoved runs after a successful move (the toast is shown
 * here); onClose closes the drawer without a move. Cancelling the MFA keeps the drawer and its choices.
 */
export function CustomerMoveDrawer({open,devices,customers,groups,viewer,logos,onClose,onMoved}:{open:boolean;devices:Device[];customers:readonly MoveCustomer[];groups:readonly DeviceGroup[];viewer:Viewer;logos?:Record<string,BrandingLogoPair>;onClose:()=>void;onMoved:(result:MoveResult)=>void}){
 const t=useT(),[locale]=useLocale();
 const [customerId,setCustomerId]=useState(''),[groupId,setGroupId]=useState<string|null|undefined>(undefined),[query,setQuery]=useState('');
 const move=useStepUp<MovePayload,MoveResult>({locale,needsStepUp:()=>true,send:payload=>api<MoveResult>('/api/console',payload)});
 const targets=customerMoveTargets(devices,customers,locale),target=targets.find(customer=>customer.id===customerId);
 // The source customers: the name the console row carries, else the visible customer of that id.
 const sources=[...new Map(devices.map(device=>[device.customerId??'',device.customerName??customers.find(customer=>customer.id===device.customerId)?.name??''])).entries()].filter(([,name])=>name);
 const nodes=target?customerMoveGroups(groups,target.id,viewer):[],ungrouped=!!target&&customerMoveUngrouped(viewer);
 const needle=query.trim().toLocaleLowerCase(locale),shown=nodes.filter(node=>node.path.toLocaleLowerCase(locale).includes(needle));
 const close=()=>{setCustomerId('');setGroupId(undefined);setQuery('');onClose();};
 const chooseCustomer=(id:string)=>{setCustomerId(id);setGroupId(undefined);setQuery('');};
 const submit=async()=>{
  if(!target||groupId===undefined)return;
  const result=await move.run(customerMovePayload(devices.map(device=>device.id),target.id,groupId));
  if(!result)return;
  toast.success(customerMoveDone(devices,target.name,t));
  setCustomerId('');setGroupId(undefined);setQuery('');
  onMoved(result);
 };
 const title=devices.length===1?t('devices.customerMove.titleOne',{name:devices[0].name}):t('devices.customerMove.titleMany',{count:devices.length});
 const blocked=!target?t('devices.customerMove.pickCustomer'):groupId===undefined?t('devices.customerMove.pickGroup'):undefined;
 return <>
  <Drawer open={open} onClose={close} title={title} description={t('devices.customerMove.description')}
   footer={<><DrawerCancel/><Btn variant="primary" icon={ArrowRight} loading={move.sending} blocked={blocked} onClick={()=>void submit()}>{target?t('devices.customerMove.submit',{customer:target.name}):t('devices.customerMove.submitPlain')}</Btn></>}>
   <div className="sdx-customer-move">
    <p className="sdx-customer-move-route">
     <span className="sdx-customer-move-ends">{sources.length===1?<RouteEnd name={sources[0][1]} logo={logos?.[sources[0][0]]}/>:<RouteEnd name={sources.map(([,name])=>name).join(', ')}/>}</span>
     <ArrowRight size={16} aria-hidden className="sdx-customer-move-arrow"/>
     <span key={target?.id??''} className="sdx-customer-move-ends sdx-title-swap"><RouteEnd name={target?.name} logo={target?logos?.[target.id]:undefined} placeholder={t('devices.customerMove.customerPlaceholder')}/></span>
    </p>
    {devices.length>1&&<Facts items={[{label:t('console.removal.devicesLabel'),value:devices.map(device=>device.name).join(', ')}]}/>}
    <Field label={t('devices.customerMove.customer')}>
     <Select value={customerId} disabled={move.busy} onChange={event=>chooseCustomer(event.target.value)}>
      <option value="">{t('devices.customerMove.customerPlaceholder')}</option>
      {targets.map(customer=><option key={customer.id} value={customer.id}>{customer.name}</option>)}
     </Select>
    </Field>
    {target&&<PickList mode="radio" label={t('groups.move.target')} search={{value:query,onChange:setQuery,label:t('groups.filter'),placeholder:t('groups.searchPlaceholder')}}
     empty={<Empty icon={Folder} title={query?t('groups.noMatch'):t('groups.noneAvailable')}>{query?t('groups.adjustSearch'):t('devices.customerMove.noGroups')}</Empty>}>
     {ungrouped&&!query&&<PickRow selected={groupId===null} icon={<Layers size={15} aria-hidden/>} label={t('groups.noGroup')} hint={t('devices.customerMove.ungroupedHint')} onSelect={()=>setGroupId(null)}/>}
     {shown.map(node=><PickRow key={node.group.id} selected={groupId===node.group.id} level={query?0:node.level} icon={<Folder size={15} aria-hidden/>} label={query?node.path:node.group.name} hint={t('groups.deviceCount',{count:node.group.deviceCount})} onSelect={()=>setGroupId(node.group.id)}/>)}
    </PickList>}
    <Card flush title={t('devices.customerMove.staysTitle')} icon={ShieldCheck} iconTone="success" level={3}>
     <ul className="sdx-plain-list"><li><span>{t('devices.customerMove.staysAgent')}</span></li><li><span>{t('devices.customerMove.staysData')}</span></li></ul>
    </Card>
    <Card flush title={t('devices.customerMove.endsTitle')} icon={CircleSlash} iconTone="warning" level={3}>
     <ul className="sdx-plain-list"><li><span>{t('devices.customerMove.endsInherited')}</span></li><li><span>{t('devices.customerMove.endsDirect')}</span></li><li><span>{t('devices.customerMove.endsWork')}</span></li></ul>
    </Card>
    {target&&<p className="sdx-customer-move-access sdx-muted-cell">{t('devices.customerMove.access',{customer:target.name})}</p>}
   </div>
  </Drawer>
  <MfaStepUp {...move.dialog}/>
 </>;
}
