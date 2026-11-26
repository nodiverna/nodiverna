'use client';

import {useCallback,useEffect,useRef,useState,type FormEvent,type ReactNode} from 'react';
import {AlertTriangle,CheckCircle2,Fingerprint,Monitor,Pencil,Plus,QrCode,Smartphone,Trash2} from 'lucide-react';
import {toast} from 'sonner';
import {api,ApiError,message,stamp} from '@/ui/base/api';
import {portalNow,SESSION_LOCK_EVENT,SESSION_SYNC_EVENT} from '@/ui/base/http';
import {registerPasskey,passkeyError,type PasskeyDevice,type PasskeyRecord,type PasskeyStatus} from '@/ui/session/passkey-client';
import {DirectTabLink,usePasskeySupport} from '@/ui/session/passkey-support';
import {opensMfaPrompt} from '@/lib/errors/codes';
import {useLocale,useStableT,useT} from '@/ui/base/locale';
import {Btn,Disclosure,Drawer,DrawerCancel,IconTile,LoadFailed,Menu,Notice,PickList,PickRow,Skeleton} from '@/ui/kit/kit';
import {Field} from '@/ui/kit/field';
import {ConfirmDialog} from '@/ui/kit/confirm-dialog';
import {MethodSection} from '@/ui/account/account-method';
import '@/ui/account/passkeys.css';

// Passkey choice for login and the first setup (the step-up dialog has its kit version in
// mfa-step-up.tsx). `pending` marks the device whose browser dialog is open: its button shows the
// spinner and the other one waits with a reason; `children` render above the divider. primary makes
// "This device" the card's primary action (the passkey-only sign-in and the setup that offers a passkey).
export function PasskeySignInOptions({busy,onSelect,title,badge,divider,pending=null,primary=false,children}:{busy:boolean;onSelect:(device:PasskeyDevice)=>void;title?:string;badge?:string;divider?:string;pending?:PasskeyDevice|null;primary?:boolean;children?:ReactNode}){
  const t=useT(),unsupported=usePasskeySupport(),waiting=busy&&!!pending;
  const blocked=(device:PasskeyDevice)=>unsupported?t(unsupported):busy&&pending!==device?t('session.blocked.busy'):undefined;
  return <div className="sd-passkey-signin">
    <div className="sd-passkey-signin-heading"><Fingerprint size={18} aria-hidden/><strong>{title??t('passkeys.signIn.title')}</strong>{badge&&<span className="sd-passkey-badge">{badge}</span>}</div>
    <div className="sd-passkey-signin-options">
      <Btn variant={primary?'primary':'secondary'} icon={Monitor} loading={waiting&&pending==='local'} blocked={blocked('local')} onClick={()=>onSelect('local')}>{t('passkeys.signIn.local')}</Btn>
      <Btn icon={QrCode} loading={waiting&&pending==='phone'} blocked={blocked('phone')} onClick={()=>onSelect('phone')}>{t('passkeys.signIn.phone')}</Btn>
    </div>
    <p className="sd-passkey-small" role={waiting?'status':undefined}>{waiting?t('passkeys.signIn.waiting'):unsupported?t(unsupported):t('passkeys.signIn.phoneHint')}</p>
    <DirectTabLink unsupported={unsupported}/>
    {children}
    <div className="sd-passkey-divider"><span>{divider??t('passkeys.signIn.orCode')}</span></div>
  </div>;
}

type ManagementProof={managementToken?:string;managementExpiresAt?:number};
type Props={
  /** MFA is on (an authenticator or a passkey exists); without it a passkey cannot be added. */
  mfaEnabled:boolean;
  /** Why every change waits (identity not confirmed, sign-in methods unavailable, another change runs), from the card. */
  blocked?:string;
  onConfirmIdentity:(afterVerify?:(proof:ManagementProof)=>void)=>void;reloadKey:number;onChanged?:()=>void};
type Editor={mode:'rename'|'delete';passkey:PasskeyRecord}|null;

/**
 * The method "Passkeys" of My account: the passkey list with a row menu (Rename, Remove), "Add passkey"
 * in a Drawer, removal through the danger ConfirmDialog. Every change that needs a fresh proof asks the
 * card for the step-up (onConfirmIdentity). Adding keeps the user gesture for WebAuthn: the step-up
 * reopens the drawer, and only the next "Add passkey" starts the browser dialog.
 */
export default function PasskeysPanel({mfaEnabled,blocked:cardBlocked,onConfirmIdentity,reloadKey,onChanged}:Props){
  const[status,setStatus]=useState<PasskeyStatus|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[addError,setAddError]=useState(''),[editError,setEditError]=useState('');
  const[managementReady,setManagementReady]=useState(false),managementGrant=useRef<{token:string;expiresAt:number}|null>(null);
  const unsupported=usePasskeySupport(),[locale]=useLocale(),t=useT(),stableT=useStableT();
  const[adding,setAdding]=useState(false),[device,setDevice]=useState<PasskeyDevice>('local'),[name,setName]=useState('Windows Hello'),[editor,setEditor]=useState<Editor>(null),[editedName,setEditedName]=useState('');
  const mounted=useRef(false),generation=useRef(0),loadSequence=useRef(0),ceremony=useRef<AbortController|null>(null),loadAbort=useRef<AbortController|null>(null);
  const defaultName=(choice:PasskeyDevice)=>choice==='phone'?t('passkeys.defaultPhoneName'):'Windows Hello';
  const load=useCallback(async()=>{
    if(!mounted.current)return;
    const sequence=++loadSequence.current,currentGeneration=generation.current,controller=new AbortController();loadAbort.current?.abort();loadAbort.current=controller;
    setLoading(true);
    const timeout=setTimeout(()=>controller.abort(new Error(stableT('passkeys.loadTimeout'))),15000);
    try{
      const next=await api<PasskeyStatus>('/api/passkeys',undefined,controller.signal);
      if(mounted.current&&generation.current===currentGeneration&&loadSequence.current===sequence){setStatus(next);setError('');}
    }catch(e){
      if(mounted.current&&generation.current===currentGeneration&&loadSequence.current===sequence){if(e instanceof ApiError&&[401,403].includes(e.status))setStatus(null);setError(message(e));}
    }finally{clearTimeout(timeout);if(loadAbort.current===controller)loadAbort.current=null;if(mounted.current&&loadSequence.current===sequence)setLoading(false);}
  },[stableT]);
  const invalidate=useCallback(()=>{generation.current++;loadSequence.current++;ceremony.current?.abort();loadAbort.current?.abort();},[]);
  useEffect(()=>{
    mounted.current=true;
    const lock=()=>{invalidate();managementGrant.current=null;setManagementReady(false);setAdding(false);setEditor(null);setStatus(null);setBusy(false);setLoading(false);};
    window.addEventListener(SESSION_LOCK_EVENT,lock);
    return()=>{mounted.current=false;invalidate();window.removeEventListener(SESSION_LOCK_EVENT,lock);};
  },[invalidate]);
  useEffect(()=>{void Promise.resolve().then(load);},[load,reloadKey,mfaEnabled]);
  const canManage=mfaEnabled&&!!status?.available&&!!status.canManage;
  const requestClose=()=>{generation.current++;ceremony.current?.abort();ceremony.current=null;managementGrant.current=null;setManagementReady(false);setBusy(false);setAdding(false);setAddError('');};
  // Closes the add drawer and asks for a fresh proof. The continuation only
  // reopens the drawer with the grant: WebAuthn needs a user click to start.
  const confirmForAdd=()=>{
    const currentGeneration=++generation.current;managementGrant.current=null;setManagementReady(false);setAdding(false);setAddError('');
    onConfirmIdentity(proof=>{
      if(!mounted.current||generation.current!==currentGeneration)return;
      if(!proof.managementToken||!proof.managementExpiresAt||proof.managementExpiresAt<=portalNow()){toast.error(t('mfa.missingProof'));return;}
      managementGrant.current={token:proof.managementToken,expiresAt:proof.managementExpiresAt};setManagementReady(true);setAdding(true);
    });
  };
  const add=async(event?:FormEvent)=>{
    event?.preventDefault();
    if(!canManage||busy||unsupported||!name.trim())return;
    const grant=managementGrant.current;
    if(!grant||grant.expiresAt<=portalNow()){confirmForAdd();return;}
    const currentGeneration=++generation.current,controller=new AbortController();ceremony.current=controller;
    managementGrant.current=null;setManagementReady(false);setBusy(true);setAddError('');
    try{
      await registerPasskey(name,device,controller.signal,grant.token);
      if(!mounted.current||generation.current!==currentGeneration)return;
      setAdding(false);toast.success(t('passkeys.saved'));await load();if(mounted.current&&generation.current===currentGeneration)onChanged?.();
    }catch(e){
      if(mounted.current&&generation.current===currentGeneration){
        if(e instanceof ApiError&&opensMfaPrompt(e.code)){setBusy(false);ceremony.current=null;confirmForAdd();}
        else setAddError(passkeyError(e,locale));
      }
    }finally{if(mounted.current&&generation.current===currentGeneration){setBusy(false);ceremony.current=null;}}
  };
  // `retry` carries the rename text of a resend after verification; a resend
  // that fails with a step-up code again only shows the message.
  const mutate=async(selected:Editor=editor,managementToken?:string,retry?:{name:string})=>{
    const renamed=retry?.name??editedName.trim();
    if(!selected||!canManage||busy||(selected.mode==='rename'&&(!renamed||(!retry&&renamed===selected.passkey.name))))return;
    const failed=(text:string)=>{if(selected.mode==='rename'&&!retry)setEditError(text);else toast.error(text);};
    if(selected.mode==='delete'&&!managementToken){
      const currentGeneration=++generation.current;setEditor(null);setEditError('');
      onConfirmIdentity(proof=>{if(!mounted.current||generation.current!==currentGeneration)return;if(!proof.managementToken){toast.error(t('mfa.missingProof'));return;}void mutate(selected,proof.managementToken);});return;
    }
    const currentGeneration=++generation.current;
    setBusy(true);setEditError('');
    try{
      await api('/api/passkeys',selected.mode==='rename'?{action:'rename',id:selected.passkey.id,name:renamed}:{action:'delete',id:selected.passkey.id,managementToken});
      if(!mounted.current||generation.current!==currentGeneration)return;
      setEditor(null);toast.success(selected.mode==='rename'?t('passkeys.renamed'):t('passkeys.removed'));if(selected.mode==='delete')window.dispatchEvent(new Event(SESSION_SYNC_EVENT));await load();if(mounted.current&&generation.current===currentGeneration)onChanged?.();
    }catch(e){
      if(!mounted.current||generation.current!==currentGeneration)return;
      if(!retry&&e instanceof ApiError&&opensMfaPrompt(e.code)){
        // Ask for a fresh proof and send the same request once more. A delete
        // never reuses its one-use token: the resend carries the new one.
        const stepUpGeneration=++generation.current;setBusy(false);setEditor(null);setEditError('');
        onConfirmIdentity(proof=>{
          if(!mounted.current||generation.current!==stepUpGeneration)return;
          if(selected.mode==='delete'&&!proof.managementToken){toast.error(t('mfa.missingProof'));return;}
          void mutate(selected,selected.mode==='delete'?proof.managementToken:undefined,{name:renamed});
        });
        return;
      }
      failed(message(e));
    }
    finally{if(mounted.current&&generation.current===currentGeneration)setBusy(false);}
  };
  const unknown=!status;
  // At least one passkey or authenticator remains. Without authenticatorCount
  // (older server) the server alone enforces the rule.
  const lastFactor=!!status&&status.authenticatorCount!==undefined&&status.count+status.authenticatorCount<=1;
  // Why changes cannot run, in order: the card's reason, no MFA, no support here, not available, identity not confirmed, a change runs.
  const changeBlocked=cardBlocked??(!mfaEnabled?t('passkeys.needAuthenticator'):status&&!status.available?t('passkeys.unavailable'):status&&!status.canManage?t('account.blocked.confirm'):busy?t('kit.busy'):undefined);
  const addBlocked=changeBlocked??(unsupported?t(unsupported):unknown?t('passkeys.loading'):undefined);
  const openAdd=()=>{managementGrant.current=null;setManagementReady(false);setAddError('');setDevice('local');setName(defaultName('local'));setAdding(true);};
  const choose=(next:PasskeyDevice)=>{setDevice(next);setName(defaultName(next));};
  const editing=editor?.mode==='rename'?editor.passkey:null,removing=editor?.mode==='delete'?editor.passkey:null;
  return <MethodSection id="passkeys-title" icon={Fingerprint} title={t('passkeys.title')} description={t('passkeys.subtitle')} state={status&&status.available?t('passkeys.count',{count:status.count}):null}
    actions={<Btn size="sm" icon={Plus} blocked={addBlocked} onClick={openAdd}>{t('passkeys.add')}</Btn>}>
    {unknown&&loading&&<Skeleton variant="facts" rows={1} label={t('passkeys.loading')}/>}
    {error&&!loading&&<LoadFailed text={status?`${error} ${t('account.staleShown')}`:error} onRetry={()=>void load()}/>}
    {status&&!status.available&&<Notice tone="warning" icon={AlertTriangle}>{t('passkeys.unavailable')}</Notice>}
    {unsupported&&<DirectTabLink unsupported={unsupported}/>}
    {status&&status.passkeys.length>0&&<ul className="sdx-account-list">{status.passkeys.map(key=><li key={key.id} className="sdx-account-row">
      <IconTile icon={key.device==='phone'?Smartphone:Monitor} tone="neutral" size="sm"/>
      <div className="sdx-account-row-text"><strong>{key.name}</strong><small>{key.device==='phone'?t('passkeys.device.phone'):t('passkeys.device.local')} · {key.deviceType==='multiDevice'?(key.backedUp?t('passkeys.syncBacked'):t('passkeys.sync')):t('passkeys.bound')}</small><small>{t('passkeys.created',{time:stamp(key.createdAt,locale)})} · {key.lastUsedAt?t('passkeys.lastUsed',{time:stamp(key.lastUsedAt,locale)}):t('passkeys.neverUsed')}</small></div>
      <Menu label={t('account.rowActions',{name:key.name})} entries={[
        {id:'rename',label:t('passkeys.rename'),icon:Pencil,blocked:changeBlocked,onSelect:()=>{setEditError('');setEditedName(key.name);setEditor({mode:'rename',passkey:key});}},
        {id:'separator',separator:true},
        {id:'remove',label:t('passkeys.remove'),icon:Trash2,danger:true,blocked:changeBlocked??(lastFactor?t('passkeys.lastFactor'):undefined),onSelect:()=>{setEditError('');setEditor({mode:'delete',passkey:key});}},
      ]}/>
    </li>)}</ul>}
    {status?.available&&status.count===0&&<p className="sdx-account-empty">{t('passkeys.empty')} {t('passkeys.emptyHint')}</p>}
    <Disclosure title={t('passkeys.help.devices')} className="sdx-account-help"><p>{t('passkeys.help.apps')}</p><p>{t('passkeys.help.microsoft')}</p></Disclosure>
    <Drawer open={adding} onClose={requestClose} title={t('passkeys.add')} description={t('passkeys.addIntro')} icon={Fingerprint} dirty={!busy&&name.trim()!==defaultName(device)}
      footer={<><DrawerCancel/><Btn variant="primary" type="submit" form="passkey-add-form" icon={Fingerprint} loading={busy} blocked={!name.trim()?t('account.blocked.name'):!canManage?addBlocked:undefined}>{t('passkeys.add')}</Btn></>}>
      <form id="passkey-add-form" className="sdx-form-grid" onSubmit={event=>void add(event)}>
        <PickList mode="radio" label={t('passkeys.location')}>
          <PickRow selected={device==='local'} icon={<Monitor size={16} aria-hidden/>} label={t('passkeys.thisDevice')} hint={t('passkeys.thisDeviceHint')} onSelect={()=>choose('local')}/>
          <PickRow selected={device==='phone'} icon={<Smartphone size={16} aria-hidden/>} label={t('passkeys.device.phone')} hint={t('passkeys.phoneHint')} onSelect={()=>choose('phone')}/>
        </PickList>
        <Field label={t('common.name')}><input id="passkey-name" value={name} maxLength={80} placeholder={t('passkeys.namePlaceholder')} onChange={event=>setName(event.target.value)}/></Field>
        <Notice tone="info" icon={device==='phone'?QrCode:Monitor}>{device==='phone'?t('passkeys.phoneInstruction'):t('passkeys.localInstruction')}</Notice>
        {managementReady&&<Notice tone="success" icon={CheckCircle2}>{t('passkeys.identityConfirmed')}</Notice>}
        {addError&&<Notice tone="danger" icon={AlertTriangle}>{addError}</Notice>}
        {busy&&<p className="sdx-account-status" role="status">{device==='phone'?t('passkeys.confirmInBrowserPhone'):t('passkeys.confirmInBrowser')}</p>}
      </form>
    </Drawer>
    <Drawer open={!!editing} onClose={()=>{setEditor(null);setEditError('');}} title={t('passkeys.renameTitle')} description={t('passkeys.renameIntro')} icon={Pencil} dirty={!!editing&&editedName.trim()!==editing.name}
      footer={<><DrawerCancel/><Btn variant="primary" type="submit" form="passkey-rename-form" loading={busy} blocked={!editedName.trim()?t('account.blocked.name'):editing&&editedName.trim()===editing.name?t('common.noChanges'):undefined}>{t('passkeys.rename')}</Btn></>}>
      <form id="passkey-rename-form" className="sdx-form-grid" onSubmit={event=>{event.preventDefault();void mutate();}}>
        <Field label={t('common.name')}><input id="passkey-edited-name" autoFocus value={editedName} maxLength={80} onChange={event=>setEditedName(event.target.value)}/></Field>
        {editError&&<Notice tone="danger" icon={AlertTriangle}>{editError}</Notice>}
      </form>
    </Drawer>
    <ConfirmDialog open={!!removing} onOpenChange={open=>{if(!open)setEditor(null);}} tone="danger" title={t('passkeys.removeTitle')} lines={removing?[{label:t('common.name'),value:removing.name}]:undefined}
      body={removing?t('passkeys.removeIntro',{name:removing.name}):undefined} confirmLabel={t('passkeys.remove')} busy={busy} onConfirm={()=>void mutate()}>
      {removing&&status?.count===1&&(status.authenticatorCount??1)>0&&<p className="sdx-account-note">{t('passkeys.lastPasskey')}</p>}
    </ConfirmDialog>
  </MethodSection>;
}
