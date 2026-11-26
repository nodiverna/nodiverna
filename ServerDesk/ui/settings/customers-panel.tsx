'use client';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {Building2,Package,Pencil,Plus,Power,PowerOff,Trash2,Users} from 'lucide-react';
import type {Viewer} from '@/lib/types';
import {defaultCustomerId} from '@/lib/default-customer';
import type {Customer} from '@/lib/server/identity/customers';
import {sortTableRows} from '@/ui/base/table-sort';
import {EMPTY_VALUE} from '@/lib/i18n/format';
import type {MessageKey} from '@/lib/i18n/translate';
import {consoleRouteHash} from '@/lib/console-route';
import {assignedIds,customerDeleteBlock,customerRowBlocks,maintenanceWindowText,multipleCustomersBlock,multipleCustomersOn,retentionText,technicianText,type CustomersView} from '@/ui/settings/customers-model';
import {useCustomers} from '@/ui/settings/customer-drawers';
import {frameHeader,useFrameRefresh,type PageFrame} from '@/ui/shell/page-frame';
import {Btn,Card,Menu,SettingsPage,StatusPill,type MenuEntry} from '@/ui/kit/kit';
import {Switch} from '@/ui/kit/field';
import {Tooltip} from '@/ui/kit/tooltip';
import {DataTable,type DataColumn,type TableSort} from '@/ui/kit/data-table';
import {ConfirmDialog} from '@/ui/kit/confirm-dialog';
import {useLocale,useT} from '@/ui/base/locale';

// Customers page (docs/customers.md). It always shows the real customers, also with demo devices, because customers
// belong to the installation. Only global Owners open it; every write asks for MFA first. The installers of a customer live on the page Add device
// (#devices/add/installer/customer/<id>, ui/devices/add-device/add-device-installers.tsx); each row menu links there. The
// drawers and the write flow live in ui/settings/customer-drawers.tsx, which the console uses for the customer folders too.
// The card "Organization" at the top holds the switch "Multiple customers" (docs/customers.md). While it is off the page is
// only that card: no table, no "Create customer", no row menus. While it is on the customer table follows in the wide slot.
// "Delete customer…" is the last row menu entry; it is never hidden and says why it cannot run (customerDeleteBlock). A
// deleted row fades out of the table (DataTable leavingKeys) for one --sd-dur before the page drops it, and the focus
// goes to the table.
export {durationLabel,maintenanceDaysText,maintenanceWindowText,technicianText,retentionText,firstCustomerNotice,type CustomerTechnicianUser,type CustomerTechnicianGroup,type CustomerAssignment,type CustomersView} from '@/ui/settings/customers-model';
export const customersPaletteKeywords:MessageKey='customers.paletteKeywords';

type CustomerColumn='name'|'devices'|'groups';
const contactOf=(customer:Customer)=>[customer.contactName,customer.contactEmail,customer.contactPhone].filter(Boolean);
/** How long a deleted row stays for its fade: --sd-dur (app/globals.css). */
export const customerLeaveMs=180;
type Leaving={customer:Customer;index:number};
/** The list with a deleted customer back at its old place while it fades out; the list itself once it is gone or not deleted. */
export function customersWithLeaving(customers:readonly Customer[],leaving:Leaving|null):Customer[]{
 if(!leaving||leaving.index<0||customers.some(customer=>customer.id===leaving.customer.id))return [...customers];
 return [...customers.slice(0,leaving.index),leaving.customer,...customers.slice(leaving.index)];
}

/** Settings › Customers; the page header of the console frame at its top (ui/shell/page-frame.ts). */
export default function CustomersPanel({viewer,frame}:{viewer:Viewer;frame?:PageFrame}){
 const t=useT(),[locale]=useLocale();
 const tableRef=useRef<HTMLDivElement>(null),[leaving,setLeaving]=useState<Leaving|null>(null);
 const customers=useCustomers({deleteFocus:tableRef,onDeleted:(customer,index)=>setLeaving({customer,index})});
 const {data,load,busy}=customers;
 const [sort,setSort]=useState<TableSort<CustomerColumn>|null>(null),[confirm,setConfirm]=useState<Customer|null>(null);
 useEffect(()=>{void Promise.resolve().then(()=>load());},[load,viewer.id]);
 useEffect(()=>{if(!leaving)return;const timer=setTimeout(()=>setLeaving(null),customerLeaveMs);return ()=>clearTimeout(timer);},[leaving]);
 // A console refresh loads the list again and keeps the table visible while it runs.
 useFrameRefresh(frame,()=>load());
 // "Create customer" exists only while "Multiple customers" is on: until a load succeeds the page has no primary.
 const on=multipleCustomersOn(data);
 const createButton=(variant:'primary'|'secondary')=><Btn variant={variant} icon={Plus} blocked={busy?t('kit.busy'):undefined} onClick={()=>customers.openManage(null)}>{t('customers.create')}</Btn>;
 const page=(content:ReactNode,wide?:ReactNode)=><>{frameHeader(frame,on?createButton('primary'):undefined)}<SettingsPage wide={wide} label={t('nav.settings.customers')} loading={!data&&!customers.loadError}
  loadError={customers.loadError||undefined} onRetry={()=>void load()} retrying={customers.loading}>{content}</SettingsPage>{customers.drawers}</>;
 if(!data)return page(null);

 const view:CustomersView=data,setting=view.multipleCustomers;
 // The focal point while off: the one switch. It applies at once after the MFA proof and rolls back on cancel or failure.
 const organization=setting&&<Card title={t('customers.multiple.cardTitle')} description={t('customers.multiple.cardDescription')} icon={Building2} iconTone="accent" id="sdx-customers-multiple">
  <Switch label={t('customers.multiple.label')} hint={t('customers.multiple.hint')} checked={setting.enabled} blocked={multipleCustomersBlock(setting,locale)} busy={busy}
   onChange={next=>customers.setMultipleCustomers(next)}/>
 </Card>;
 if(!on)return page(organization);
 const rows=sortTableRows(customersWithLeaving(view.customers,leaving),sort,{name:customer=>customer.name,devices:customer=>customer.deviceCount,groups:customer=>customer.groupCount});
 const menu=(customer:Customer):MenuEntry[]=>{
  const blocks=customerRowBlocks(customer,busy,locale),active=customer.status==='active';
  return [
   // The icons of the tree menu for the same actions (customerActionIcons), so an action keeps its look in both places.
   {id:'manage',label:t('tree.customer.manage'),icon:Pencil,blocked:blocks.manage,onSelect:()=>customers.openManage(customer)},
   {id:'access',label:t('tree.customer.access'),icon:Users,blocked:blocks.access,onSelect:()=>customers.openAccess(customer)},
   {id:'installers',label:t('tree.customer.installers'),icon:Package,href:consoleRouteHash({view:'add-device',installer:true,customerId:customer.id})},
   {id:'separator',separator:true},
   active?{id:'deactivate',label:t('customers.menu.deactivate'),icon:PowerOff,danger:true,blocked:blocks.status,onSelect:()=>setConfirm(customer)}
    :{id:'activate',label:t('customers.menu.activate'),icon:Power,blocked:blocks.status,onSelect:()=>void customers.setStatus(customer,'active')},
   {id:'delete',label:t('customers.menu.delete'),icon:Trash2,danger:true,blocked:customerDeleteBlock(customer,busy,locale),onSelect:()=>customers.openDelete(customer)},
  ];
 };
 const columns:DataColumn<Customer>[]=[
  {id:'name',label:t('common.customer'),primary:true,sort:{first:'asc'},cell:customer=><span className="sdx-customer-name"><strong>{customer.name}</strong>
   {customer.status==='disabled'&&<StatusPill kind="neutral" size="sm">{t('fleet.disabled')}</StatusPill>}</span>,
   // The Default tag explains itself in a Tooltip on hover and keyboard focus, and to screen readers through its sr-only
   // sentence. It sits outside the row open button (aside), because a focusable part must not sit inside a button.
   aside:customer=>customer.id===defaultCustomerId?<Tooltip content={t('customers.defaultTitle')}><span className="sdx-tag sdx-tag-sm" tabIndex={0}>{t('customers.standard')}<span className="sr-only"> {t('customers.defaultTitle')}</span></span></Tooltip>:null},
  {id:'contact',label:t('customers.contact'),wrap:true,cell:customer=>{const contact=contactOf(customer);return contact.length?<span className="sdx-cell-stack">{contact.map((entry,index)=>index?<small key={entry}>{entry}</small>:<span key={entry}>{entry}</span>)}</span>:EMPTY_VALUE;}},
  {id:'devices',label:t('tree.devices'),align:'end',mono:true,sort:{first:'desc'},cell:customer=>customer.deviceCount},
  {id:'groups',label:t('customers.col.groups'),align:'end',mono:true,sort:{first:'desc'},cell:customer=>customer.groupCount},
  {id:'access',label:t('customers.col.access'),cell:customer=>technicianText(assignedIds(view.assignments,customer.id,'user').length,assignedIds(view.assignments,customer.id,'group').length,locale)},
  {id:'retention',label:t('customers.retention'),hideBelow:1280,cell:customer=>retentionText(customer.auditRetentionDays,locale)},
  {id:'window',label:t('customers.window'),wrap:true,cell:customer=>maintenanceWindowText(customer.maintenanceWindow,locale)},
  {id:'actions',label:t('fleet.col.actions'),hideLabel:true,className:'sdx-col-actions',cell:customer=><Menu label={t('customers.menu.label',{name:customer.name})} entries={menu(customer)}/>},
 ];
 // A row click is "Manage customer…" while that entry is available.
 const open=(customer:Customer)=>{if(!customerRowBlocks(customer,busy,locale).manage)customers.openManage(customer);};
 const table=<DataTable<Customer> columns={columns} rows={rows} rowKey={customer=>customer.id} label={t('nav.settings.customers')} cards entranceId="settings-customers"
  sort={sort} onSort={next=>setSort(next as TableSort<CustomerColumn>)} onOpen={open} busy={customers.loading} leavingKeys={leaving?[leaving.customer.id]:undefined}
  foot={t('customers.foot',{count:view.customers.length})} empty={{icon:Building2,title:t('customers.none'),children:t('customers.noneHint'),action:createButton('secondary')}}/>;
 return page(organization,<>
  {/* The focus target after a delete: the row the user acted on is gone, the table it was in stays. */}
  <div ref={tableRef} tabIndex={-1}>{table}</div>
  <ConfirmDialog open={!!confirm} onOpenChange={next=>{if(!next)setConfirm(null);}} tone="danger"
   title={t('customers.deactivate.title',{name:confirm?.name??''})} body={t('customers.disableHint')} confirmLabel={t('customers.deactivate.confirm')}
   onConfirm={()=>{const customer=confirm;setConfirm(null);if(customer)void customers.setStatus(customer,'disabled');}}/>
 </>);
}
