'use client';
// The customer drawers (docs/customers.md): "Manage customer…" (create and edit) and "Technician access…", their
// form state, the GET /api/customers load and the one write flow of every customer change. Settings › Customers
// (ui/settings/customers-panel.tsx) and the console (CustomerDrawerHost, for the customer folder menu in Devices) both use
// useCustomers, so an action keeps its name, its checks and its feedback in both places.
//
// Every write (create, update, set-status, set-technicians) goes through one useStepUp, which asks for a fresh MFA
// proof before the send only where lib/step-up.ts says so (customerBodyNeedsStepUp): always for the technicians, for an
// edit only when the customer's audit retention gets shorter, never for create and the status. A reply that still asks
// for a proof opens the dialog and resends once. Cancelling the MFA dialog sends nothing and keeps the drawer with its input. A failure shows a toast and
// keeps the drawer open; a success shows the toast, closes the drawer and takes the list of the answer. The switch
// "Multiple customers" of Settings › Customers runs through the same useStepUp (setMultipleCustomers), and it always
// asks for the proof first (set-multiple-customers is in customerStepUpActions).
//
// "Delete customer…" (the row menu, and the DangerZone at the end of the manage drawer) opens the delete drawer: the
// kit NameConfirmDrawer, in which the user types the name. The delete always asks for the proof first (delete is in
// customerStepUpActions). A success closes the drawer, takes the list of the answer and tells onDeleted (the page fades
// the row out, the console leaves the customer's scope). A failure keeps the drawer open with the typed name; a
// CUSTOMER_IN_USE or a stale revision (CONFLICT) loads the list again first, so the menu shows the current reason.
import {useCallback,useEffect,useId,useRef,useState,type FormEvent,type ReactNode,type RefObject} from 'react';
import {AlertTriangle,Building2,Trash2,User,Users} from 'lucide-react';
import {toast} from 'sonner';
import type {Customer} from '@/lib/server/identity/customers';
import {api,message} from '@/ui/base/api';
import {MfaStepUp} from '@/ui/session/mfa-step-up';
import {useStepUp} from '@/ui/session/step-up-retry';
import {assignedIds,customerBodyNeedsStepUp,customerDeleteBlock,customerFormErrors,defaultCustomerName,firstCustomerNotice,customerFormOf,customerPayload,customerTimeZones,dayLabels,durationChoices,durationLabel,sameCustomerForm,sameSelection,technicianGroupHint,technicianMatches,technicianUserHint,toggleCustomerDay,type CustomerForm,type CustomersView} from '@/ui/settings/customers-model';
import {Btn,DangerZone,Drawer,DrawerCancel,Notice,PickCheckRow,PickList,Skeleton,useDrawerClose} from '@/ui/kit/kit';
import {NameConfirmDrawer} from '@/ui/kit/name-confirm-drawer';
import {Field,Select,Switch} from '@/ui/kit/field';
import {useLocale,useT} from '@/ui/base/locale';
import '@/ui/settings/customers-panel.css';

const endpoint='/api/customers';
/** One customer change. The body adds action, id, revision and the managementToken of the step-up. */
export type CustomerIntent={action:'create';payload:Record<string,unknown>}|{action:'update';customer:Customer;payload:Record<string,unknown>}
 |{action:'set-status';customer:Customer;status:'active'|'disabled'}|{action:'set-technicians';customer:Customer;userIds:string[];groupIds:string[]}|{action:'delete';customer:Customer};
/** The request body of an intent, without the managementToken (useStepUp adds it). */
export function customerIntentBody(intent:CustomerIntent):Record<string,unknown>{
 switch(intent.action){
  case 'create':return {action:'create',...intent.payload};
  case 'update':return {action:'update',id:intent.customer.id,revision:intent.customer.revision,...intent.payload};
  case 'set-technicians':return {action:'set-technicians',id:intent.customer.id,revision:intent.customer.revision,userIds:intent.userIds,groupIds:intent.groupIds};
  case 'delete':return {action:'delete',id:intent.customer.id,revision:intent.customer.revision};
  default:return {action:'set-status',id:intent.customer.id,revision:intent.customer.revision,status:intent.status};
 }
}
const successKey=(intent:CustomerIntent)=>intent.action==='delete'?'customers.delete.done':intent.action==='create'?'customers.toast.created':intent.action==='update'?'customers.toast.saved':intent.action==='set-technicians'?'customers.toast.accessSaved':intent.status==='disabled'?'customers.toast.disabled':'customers.toast.enabled';

type ManageState={open:boolean;customer:Customer|null;initial:CustomerForm};
type AccessState={open:boolean;customer:Customer;userIds:string[];groupIds:string[]};
type DeleteState={open:boolean;customer:Customer};
/** A refusal that loads the list again before its error toast: a stale switch of "Multiple customers", and a delete refused for new data or a stale revision. */
const reloadsBeforeError=(payload:Record<string,unknown>,code:unknown)=>payload.action==='set-multiple-customers'?code==='CONFLICT':payload.action==='delete'&&(code==='CUSTOMER_IN_USE'||code==='CONFLICT');
type Answer=CustomersView&{id?:string};
/** The drawer a device tree request asked for while its customer list loads (CustomerDrawerHost). */
type LoadingDrawer={drawer:'manage'|'access';name:string;open:boolean;onClose:()=>void};

/**
 * The customers of the installation with their drawers and their write flow. load() runs GET /api/customers and keeps
 * the loaded list visible while it runs; with report it shows a failure as a toast instead of loadError. closeKey: a
 * change asks an open drawer to close as the user would (the console passes its route). onSaved runs after every
 * successful write. loading: the drawer asked for opens at once with a Skeleton in the place of its form; it is the same
 * Drawer that shows the form once openManage or openAccess runs, so the drawer does not close and open again.
 * onDeleted runs after a successful delete with the customer and its index in the list before; deleteFocus is where the
 * focus goes after it (the page's table).
 */
export function useCustomers({onSaved,onDeleted,deleteFocus,closeKey,loading:pending}:{onSaved?:()=>void;onDeleted?:(customer:Customer,index:number)=>void;deleteFocus?:RefObject<HTMLElement|null>;closeKey?:unknown;loading?:LoadingDrawer|null}={}){
 const t=useT(),[locale]=useLocale();
 const [data,setData]=useState<CustomersView|null>(null),[loading,setLoading]=useState(false),[loadError,setLoadError]=useState('');
 const [manage,setManage]=useState<ManageState|null>(null),[form,setForm]=useState<CustomerForm>(()=>customerFormOf(null)),[submitted,setSubmitted]=useState(false);
 const [remove,setRemove]=useState<DeleteState|null>(null),deleteReturn=useRef<HTMLElement|null>(null);
 const [access,setAccess]=useState<AccessState|null>(null),[selectedUsers,setSelectedUsers]=useState<string[]>([]),[selectedGroups,setSelectedGroups]=useState<string[]>([]),[filter,setFilter]=useState('');
 const mounted=useRef(false),sequence=useRef(0);
 useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;};},[]);
 const load=useCallback(async({report=false}:{report?:boolean}={}):Promise<CustomersView|null>=>{
  const current=++sequence.current;setLoading(true);
  try{
   const result=await api<CustomersView>(endpoint);
   if(!mounted.current||current!==sequence.current)return null;
   setData(result);setLoadError('');
   return result;
  }catch(failure){
   if(mounted.current&&current===sequence.current){if(report)toast.error(message(failure,locale));else setLoadError(message(failure,locale));}
   return null;
  }finally{if(mounted.current&&current===sequence.current)setLoading(false);}
 },[locale]);
 // The MFA proof comes first only where the shared rule says so, decided on the loaded list. A switch of "Multiple
 // customers" based on a stale revision (CONFLICT), and a delete refused for new data or a stale revision, load the
 // page again before the error toast; the open delete drawer then holds the customer of the new list.
 const step=useStepUp<Record<string,unknown>,Answer>({locale,needsStepUp:body=>customerBodyNeedsStepUp(body,data?.customers),send:payload=>api<Answer>(endpoint,payload),
  onError:(failure,payload)=>{
   if(!reloadsBeforeError(payload,(failure as {code?:unknown}|null)?.code))return false;
   void load().then(view=>{
    if(!mounted.current)return;
    const fresh=view?.customers.find(customer=>customer.id===payload.id);
    if(fresh)setRemove(old=>old&&old.customer.id===fresh.id?{...old,customer:fresh}:old);
    toast.error(message(failure,locale));
   });
   return true;
  }});
 const take=(result:Answer)=>setData(old=>({customers:result.customers,technicians:result.technicians??old?.technicians,assignments:result.assignments??old?.assignments,multipleCustomers:result.multipleCustomers??old?.multipleCustomers}));
 const write=async(intent:CustomerIntent):Promise<boolean>=>{
  const index=intent.action==='delete'?data?.customers.findIndex(customer=>customer.id===intent.customer.id)??-1:-1;
  const result=await step.run(customerIntentBody(intent));
  if(!result||!mounted.current)return false;
  take(result);
  toast.success(t(successKey(intent)));
  onSaved?.();
  if(intent.action==='delete')onDeleted?.(intent.customer,index);
  return true;
 };
 /**
  * Turns "Multiple customers" on or off (the kit Switch of Settings › Customers): the MFA proof first, then the
  * request with the revision of the loaded setting. true: the page shows the state of the answer and a success toast;
  * false (cancelled, refused or failed; useStepUp or onError already showed the error) rolls the switch back.
  */
 const setMultipleCustomers=async(enabled:boolean):Promise<boolean>=>{
  const setting=data?.multipleCustomers;
  if(!setting)return false;
  const result=await step.run({action:'set-multiple-customers',enabled,revision:setting.revision});
  if(!result||!mounted.current)return false;
  take(result);
  toast.success(t(enabled?'customers.multiple.turnedOn':'customers.multiple.turnedOff'));
  onSaved?.();
  return true;
 };

 // ---- Opening ----
 /** Opens "Manage customer…" (customer) or "Create customer" (null) unless a request runs; view: a list loaded just now. */
 const openManage=(customer:Customer|null,view:CustomersView|null=data):boolean=>{
  if(step.busy||!view)return false;
  const initial=customerFormOf(customer);
  setForm(initial);setSubmitted(false);setManage({open:true,customer,initial});
  return true;
 };
 /** Opens "Technician access…" unless a request runs. */
 const openAccess=(customer:Customer,view:CustomersView|null=data):boolean=>{
  if(step.busy||!view)return false;
  const userIds=assignedIds(view.assignments,customer.id,'user'),groupIds=assignedIds(view.assignments,customer.id,'group');
  setSelectedUsers(userIds);setSelectedGroups(groupIds);setFilter('');setAccess({open:true,customer,userIds,groupIds});
  return true;
 };
 // A user close waits while the request runs; a success closes from here (open={false}, no question).
 const closeManage=()=>{if(!step.sending)setManage(old=>old&&{...old,open:false});};
 const closeAccess=()=>{if(!step.sending)setAccess(old=>old&&{...old,open:false});};
 /** Opens the delete drawer unless a request runs; a blocked entry never calls it. */
 const openDelete=(customer:Customer):boolean=>{
  if(step.busy)return false;
  deleteReturn.current=null;setRemove({open:true,customer});
  return true;
 };
 const closeDelete=()=>{if(!step.sending)setRemove(old=>old&&{...old,open:false});};

 // ---- Manage drawer ----
 const manageId=useId(),editing=!!manage?.customer;
 const manageDirty=!!manage&&!sameCustomerForm(form,manage.initial);
 const errors=customerFormErrors(form),fieldError=(field:keyof typeof errors)=>submitted&&errors[field]?t(errors[field]!):undefined;
 const change=(patch:Partial<CustomerForm>)=>setForm(old=>({...old,...patch}));
 const submitManage=async(event:FormEvent)=>{
  event.preventDefault();
  if(!manage?.open||step.busy||editing&&!manageDirty)return;
  setSubmitted(true);
  // An invalid form sends nothing; the errors show under their fields and follow the input from now on.
  if(Object.keys(errors).length)return;
  const payload=customerPayload(form),customer=manage.customer;
  if(await write(customer?{action:'update',customer,payload}:{action:'create',payload}))setManage(old=>old&&{...old,open:false});
 };
 const zones=customerTimeZones(form.timeZone);
 const manageDrawer=manage&&<Drawer open={manage.open} onClose={closeManage} dirty={manageDirty&&!step.sending} closeKey={closeKey} icon={Building2}
  title={manage.customer?t('customers.drawer.manageTitle',{name:manage.customer.name}):t('customers.create')}
  footer={<><DrawerCancel/><Btn type="submit" form={manageId} variant="primary" loading={step.sending} blocked={editing&&!manageDirty?t('common.noChanges'):undefined}>{editing?t('customers.drawer.save'):t('customers.create')}</Btn></>}>
  <form id={manageId} className="sdx-form-grid" noValidate onSubmit={event=>void submitManage(event)}>
   {/* The consequence before the action: the second customer switches the customer boundary on. */}
   {!editing&&firstCustomerNotice(data)&&<Notice tone="warning" icon={AlertTriangle}>{t('customers.firstCustomerNotice')}</Notice>}
   <Field label={t('common.name')} error={fieldError('name')}><input value={form.name} maxLength={80} autoComplete="off" required autoFocus onChange={event=>change({name:event.target.value})}/></Field>
   <Field label={t('customers.contactName')}><input value={form.contactName} maxLength={120} autoComplete="off" onChange={event=>change({contactName:event.target.value})}/></Field>
   <div className="sdx-customer-columns">
    <Field label={t('customers.email')}><input type="email" value={form.contactEmail} maxLength={254} autoComplete="off" onChange={event=>change({contactEmail:event.target.value})}/></Field>
    <Field label={t('customers.phone')}><input type="tel" value={form.contactPhone} maxLength={40} autoComplete="off" onChange={event=>change({contactPhone:event.target.value})}/></Field>
   </div>
   <fieldset className="sdx-customer-section">
    <legend>{t('customers.retention')}</legend>
    {/* A form field here: the switch changes the draft only and sends nothing. */}
    <Switch label={t('customers.ownRetention')} checked={form.ownRetention} hint={form.ownRetention?undefined:t('customers.retentionDefault')} onChange={next=>change({ownRetention:next})}/>
    {form.ownRetention&&<Field label={t('customers.daysLabel')} hint={t('customers.retentionHint')} error={fieldError('retentionDays')} className="sdx-customer-days-field">
     <input type="number" inputMode="numeric" min={1} max={3650} step={1} value={form.retentionDays} onChange={event=>change({retentionDays:event.target.value})}/>
    </Field>}
   </fieldset>
   <fieldset className="sdx-customer-section">
    <legend>{t('customers.window')}</legend>
    <Switch label={t('customers.setWindow')} checked={form.windowOn} onChange={next=>change({windowOn:next})}/>
    {form.windowOn&&<>
     <WeekdayGroup days={form.days} error={fieldError('days')} onToggle={day=>setForm(old=>toggleCustomerDay(old,day))}/>
     <div className="sdx-customer-columns sdx-customer-window">
      <Field label={t('customers.start')}><input type="time" step={900} value={form.start} required onChange={event=>change({start:event.target.value})}/></Field>
      <Field label={t('customers.duration')}><Select value={form.duration} onChange={event=>change({duration:Number(event.target.value)})}>{durationChoices(form.duration).map(minutes=><option key={minutes} value={minutes}>{durationLabel(minutes,locale)}</option>)}</Select></Field>
      <Field label={t('customers.timeZone')}><Select wide value={form.timeZone} onChange={event=>change({timeZone:event.target.value})}>{zones.map(zone=><option key={zone} value={zone}>{zone}</option>)}</Select></Field>
     </div>
    </>}
   </fieldset>
   {/* The irreversible action last (nodiverna-ui §4): it opens the delete drawer in place of this one, after "Discard changes?" while the form is dirty. */}
   {manage.customer&&<CustomerDeleteZone blocked={customerDeleteBlock(manage.customer,step.busy,locale)} onDelete={()=>{if(manage.customer)openDelete(manage.customer);}}/>}
  </form>
 </Drawer>;

 // ---- Delete drawer ----
 // The consequences, then (for the last other customer) the end of the customer boundary, then the name field.
 const confirmDelete=async()=>{
  if(!remove?.open||step.busy)return;
  if(await write({action:'delete',customer:remove.customer})){deleteReturn.current=deleteFocus?.current??null;setRemove(old=>old&&{...old,open:false});}
 };
 const deleteDrawer=remove&&<NameConfirmDrawer open={remove.open} name={remove.customer.name} closeKey={closeKey} returnFocus={deleteReturn} icon={Trash2} iconTone="danger"
  title={t('customers.delete.title',{name:remove.customer.name})} description={t('customers.delete.description',{name:remove.customer.name})}
  fieldLabel={t('customers.delete.typeName')} confirmLabel={t('customers.delete.confirm')} enterNameFirst={t('customers.delete.enterNameFirst')} busy={step.sending}
  onClose={closeDelete} onConfirm={()=>void confirmDelete()}>
  <p>{t('customers.delete.removedWith')}</p>
  <p className="sdx-customer-delete-kept">{t('customers.delete.auditKept')}</p>
  {data?.multipleCustomers?.otherCustomers===1&&<Notice tone="warning" icon={AlertTriangle}>{t('customers.delete.lastNotice',{defaultName:defaultCustomerName(data)})}</Notice>}
 </NameConfirmDrawer>;

 // ---- Technician access drawer ----
 const accessId=useId();
 const users=data?.technicians?.users??[],groups=data?.technicians?.groups??[];
 const accessDirty=!!access&&(!sameSelection(selectedUsers,access.userIds)||!sameSelection(selectedGroups,access.groupIds));
 const pick=(set:(update:(old:string[])=>string[])=>void,id:string,checked:boolean)=>set(old=>checked?(old.includes(id)?old:[...old,id]):old.filter(entry=>entry!==id));
 const submitAccess=async(event:FormEvent)=>{
  event.preventDefault();
  if(!access?.open||step.busy||!accessDirty)return;
  // Ids in list order, so the request does not depend on the click order.
  const intent:CustomerIntent={action:'set-technicians',customer:access.customer,userIds:users.filter(user=>selectedUsers.includes(user.id)).map(user=>user.id),groupIds:groups.filter(group=>selectedGroups.includes(group.id)).map(group=>group.id)};
  if(await write(intent))setAccess(old=>old&&{...old,open:false});
 };
 const shownUsers=users.filter(user=>technicianMatches(filter,locale,user.label,user.email)),shownGroups=groups.filter(group=>technicianMatches(filter,locale,group.name));
 const accessDrawer=access&&<Drawer open={access.open} onClose={closeAccess} dirty={accessDirty&&!step.sending} closeKey={closeKey} icon={Users}
  title={t('customers.drawer.accessTitle',{name:access.customer.name})} description={t('customers.accessHint')}
  footer={<><DrawerCancel/><Btn type="submit" form={accessId} variant="primary" loading={step.sending} blocked={!accessDirty?t('common.noChanges'):undefined}>{t('customers.drawer.saveAccess')}</Btn></>}>
  <form id={accessId} className="sdx-form-grid" onSubmit={event=>void submitAccess(event)}>
   <PickList mode="checkbox" label={t('customers.technicians.label')} search={{value:filter,onChange:setFilter,label:t('customers.filterLabel'),placeholder:t('customers.filterPlaceholder')}}
    empty={<p className="sdx-customer-empty">{users.length||groups.length?t('customers.noMatch'):t('customers.noGroups')}</p>}>
    {shownUsers.map(user=><PickCheckRow key={'user:'+user.id} checked={selectedUsers.includes(user.id)} icon={<User size={15} aria-hidden/>} label={user.label} hint={technicianUserHint(user,locale)}
     onChange={checked=>pick(setSelectedUsers,user.id,checked)}/>)}
    {shownGroups.map(group=><PickCheckRow key={'group:'+group.id} checked={selectedGroups.includes(group.id)} icon={<Users size={15} aria-hidden/>} label={group.name} hint={technicianGroupHint(group,locale)}
     onChange={checked=>pick(setSelectedGroups,group.id,checked)}/>)}
   </PickList>
  </form>
 </Drawer>;

 // ---- The loading drawer ----
 // Title, icon tile and footer of the drawer asked for; the submit waits for the list.
 const loadingDrawer=(kind:'manage'|'access')=>pending&&<Drawer open={pending.open} onClose={pending.onClose} closeKey={closeKey} icon={kind==='manage'?Building2:Users}
  title={t(kind==='manage'?'customers.drawer.manageTitle':'customers.drawer.accessTitle',{name:pending.name})} description={kind==='access'?t('customers.accessHint'):undefined}
  footer={<><DrawerCancel/><Btn type="submit" form={kind==='manage'?manageId:accessId} variant="primary" blocked={t('customers.blocked.loading')}>{kind==='manage'?t('customers.drawer.save'):t('customers.drawer.saveAccess')}</Btn></>}>
  <Skeleton variant="facts" label={t('customers.drawer.loading')} after={15000}/>
 </Drawer>;

 // Each drawer keeps its place in the tree: the loading drawer of a kind sits where that kind's form drawer sits.
 const drawers:ReactNode=<>{pending?.drawer==='manage'?loadingDrawer('manage'):manageDrawer}{pending?.drawer==='access'?loadingDrawer('access'):accessDrawer}{deleteDrawer}<MfaStepUp {...step.dialog}/></>;
 return {data,loading,loadError,load,busy:step.busy,sending:step.sending,openManage,openAccess,openDelete,setMultipleCustomers,
  /** Deactivate (after its ConfirmDialog) or activate a customer. */
  setStatus:(customer:Customer,status:'active'|'disabled')=>write({action:'set-status',customer,status}),
  drawers};
}

/**
 * The DangerZone of the manage drawer: "Delete customer…" closes the drawer through its guarded close ("Discard
 * changes?" first while the form is dirty) and then opens the delete drawer. Blocked with customerDeleteBlock.
 */
function CustomerDeleteZone({blocked,onDelete}:{blocked?:string;onDelete:()=>void}){
 const t=useT(),close=useDrawerClose();
 return <DangerZone title={t('customers.delete.zoneTitle')} description={t('customers.delete.zoneDescription')} label={t('customers.menu.delete')} icon={Trash2} blocked={blocked}
  onClick={()=>close?close(onDelete):onDelete()}/>;
}

/** The seven weekday toggles of a maintenance window: one group named "Days", each a pressed or plain kit Btn. */
function WeekdayGroup({days,error,onToggle}:{days:readonly number[];error?:string;onToggle:(day:number)=>void}){
 const t=useT(),labelId=useId(),errorId=useId();
 return <div className="sdx-field sdx-customer-weekdays">
  <span id={labelId} className="sdx-field-label">{t('customers.daysLabel')}</span>
  <div role="group" aria-labelledby={labelId} aria-describedby={error?errorId:undefined}>
   {dayLabels.map((label,index)=><Btn key={label} size="sm" pressed={days.includes(index+1)} onClick={()=>onToggle(index+1)}>{t(label)}</Btn>)}
  </div>
  {error&&<p id={errorId} className="sdx-field-error">{error}</p>}
 </div>;
}

/**
 * A request from the device tree or the customer scope menu to open one drawer of a customer; each request is a new
 * object. customerName: the name the console shows, the title of the drawer while the list loads.
 */
export type CustomerDrawerRequest={customerId:string;customerName:string;drawer:'manage'|'access'};
/** The request being handled: open is false once its loading drawer closed; loading while its GET runs. */
type HostRun={request:CustomerDrawerRequest;open:boolean;loading:boolean};
/**
 * The customer drawers over the Devices area (L4): a request opens the drawer asked for at once, in the render that gets
 * the request, with a Skeleton as its body and the submit blocked; it loads GET /api/customers and then shows the form
 * in the same drawer, through the same checks as the Settings page. A customer that is gone and a refused drawer close
 * it with an info toast, a failed load with the error toast. A close by the user before the list arrives ends the
 * request: nothing opens later and nothing is sent. A second request while one loads has no effect. The hash, the view
 * and the tree stay as they are; the drawer gives focus back to the element that had it when it opened (the menu trigger
 * or tree item). closeKey (the console route) closes an open drawer through its dirty guard.
 */
export function CustomerDrawerHost({request,closeKey,onSaved,onDeleted,onDone}:{request:CustomerDrawerRequest|null;closeKey:unknown;
 /** After every successful save: the console reloads its data (tree, scope header, crumbs). */
 onSaved:()=>void;
 /** After a delete from the manage drawer (its DangerZone), after onSaved: the console leaves the customer's scope. */
 onDeleted?:(customerId:string)=>void;
 /** The request is handled (opened, refused or failed); the console clears it. */
 onDone:()=>void}){
 const t=useT();
 const [seen,setSeen]=useState<CustomerDrawerRequest|null>(null),[run,setRun]=useState<HostRun|null>(null),closed=useRef<CustomerDrawerRequest|null>(null);
 // A new request opens its loading drawer in this render (not one render later), unless a load still runs.
 let current=run;
 if(request!==seen){setSeen(request);if(request&&!run?.loading){current={request,open:true,loading:true};setRun(current);}}
 const shown=current;
 const customers=useCustomers({onSaved,onDeleted:customer=>onDeleted?.(customer.id),closeKey,loading:shown&&{drawer:shown.request.drawer,name:shown.request.customerName,open:shown.open,
  onClose:()=>{closed.current=shown.request;setRun(old=>old&&{...old,open:false});}}});
 const handled=useRef<CustomerDrawerRequest|null>(null),loadingRef=useRef(false),latest=useRef(customers);
 useEffect(()=>{latest.current=customers;});
 useEffect(()=>{
  if(!request||handled.current===request)return;
  handled.current=request;
  // One request at a time: a request while the list loads has no effect.
  if(loadingRef.current){onDone();return;}
  loadingRef.current=true;
  void latest.current.load({report:true}).then(view=>{
   loadingRef.current=false;onDone();
   // Closed by the user while the list loaded: nothing opens and nothing is sent.
   if(closed.current===request){setRun(null);return;}
   // The loading drawer closes (focus goes back to its opener) with the reason as a toast; load already showed a failure.
   const refuse=(reason?:string)=>{if(reason)toast.info(reason);setRun(old=>old&&{...old,open:false,loading:false});};
   if(!view){refuse();return;}
   const customer=view.customers.find(entry=>entry.id===request.customerId);
   if(!customer){refuse(t('customers.focus.notFound'));return;}
   // The form takes the loading drawer's place in the same update, so it is the same open Drawer.
   const opened=request.drawer==='manage'?latest.current.openManage(customer,view):latest.current.openAccess(customer,view);
   if(opened)setRun(null);else refuse();
  });
 // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per request object; t and onDone are read from the render that got the request.
 },[request]);
 return customers.drawers;
}
