'use client';
import {useState,useEffect,useCallback,useRef,type FormEvent,type ReactNode} from 'react';
import {AlertTriangle,Download,KeyRound,LifeBuoy,Lock,Pencil,Plus,RefreshCw,ShieldCheck,Trash2} from 'lucide-react';
import {toast} from 'sonner';
import type {Viewer} from '@/lib/types';
import {api,ApiError,message,stamp,downloadText} from '@/ui/base/api';
import PasskeysPanel from '@/ui/account/passkeys-panel';
import {MfaStepUp} from '@/ui/session/mfa-step-up';
import {SESSION_LOCK_EVENT,SESSION_SYNC_EVENT} from '@/ui/base/http';
import '@/ui/account/account.css';
import PasswordSettings from '@/ui/account/password-settings';
import MfaQrCode from '@/ui/session/mfa-qr-code';
import {useLocale,useStableT,useT} from '@/ui/base/locale';
import {Btn,Card,CopyValue,Disclosure,Drawer,DrawerCancel,EntranceList,Facts,IconTile,LoadFailed,Menu,Notice,RetryAction,SettingsPage,Skeleton,StatusPill,type IconTone,type StatusKind} from '@/ui/kit/kit';
import {Field} from '@/ui/kit/field';
import {ConfirmDialog} from '@/ui/kit/confirm-dialog';
import {PreferencesCard,type PreferenceProps} from '@/ui/account/account-preferences';
import {initialsOf} from '@/ui/shell/shell';
import {MethodSection} from '@/ui/account/account-method';
import {accountDetail,accountName,viewerNameParts} from '@/lib/account-display';
import {EMPTY_VALUE} from '@/lib/i18n/format';
import {frameHeader,useFrameRefresh,type PageFrame} from '@/ui/shell/page-frame';

type AuthenticatorRecord={id:string;name:string;createdAt:number;lastUsedAt:number|null};
type MfaStatus={enabled:boolean;available:boolean;verifiedUntil:number|null;authenticated?:boolean;passkeyCount?:number;passkeysAvailable?:boolean;authenticatorCount:number;authenticators?:AuthenticatorRecord[];maximumAuthenticators:number};
type ManagementProof={managementToken?:string;managementExpiresAt?:number};

type AuthenticatorSetup={challengeId?:string;secret:string;uri:string;expiresAt:number};
type AuthenticatorEditor={mode:'add'|'reset'|'rename'|'delete';entry?:AuthenticatorRecord};
type ManagementIntent={action:'begin'|'delete';editor:AuthenticatorEditor;name:string}|{action:'recovery'};

/**
 * My account (#account): one SettingsPage with the cards Profile, Sign-in & security (local accounts),
 * the slots for Server sign-ins and the personal assistant key, and Preferences. The cards rise once per
 * page load (EntranceList "account"). Sample devices do not change this page: it always shows real data. With the
 * console frame (ui/shell/page-frame.ts) the page header comes first, and a console refresh loads the sign-in methods again.
 */
export function AccountPanel({viewer,serverSignIns,assistantKey,frame,preferences}:{viewer:Viewer;serverSignIns?:ReactNode;assistantKey?:ReactNode;frame?:PageFrame;preferences?:PreferenceProps}){
  const t=useT(),entra=viewer.identitySource==='entra';
  return <>{frameHeader(frame)}<SettingsPage label={t('nav.account.title')} className="sdx-account">
    <EntranceList id="account" className="sdx-account-cards">
      <div key="profile">{entra?<EntraProfileCard viewer={viewer}/>:<ProfileCard viewer={viewer}/>}</div>
      {!entra&&<div key="security"><SignInSecurityCard viewer={viewer} frame={frame}/></div>}
      {serverSignIns!=null&&<div key="sign-ins">{serverSignIns}</div>}
      {assistantKey!=null&&<div key="assistant">{assistantKey}</div>}
      <div key="preferences"><PreferencesCard {...preferences}/></div>
    </EntranceList>
  </SettingsPage></>;
}

const rolesOf=(viewer:Viewer,none:string)=>viewer.roles?.length?viewer.roles.join(', '):none;

/** The Profile card of a Nodiverna account: avatar, name, user name, the sign-in and the roles. */
export function ProfileCard({viewer}:{viewer:Viewer}){
  const t=useT(),name=accountName(viewerNameParts(viewer));
  return <Card title={t('account.profile.title')} id="account-profile-title" className="sdx-account-profile">
    <div className="sdx-account-identity"><span className="sdx-avatar" aria-hidden="true">{initialsOf(name)}</span>
      <Facts items={[{id:'name',label:t('account.profile.name'),value:name||EMPTY_VALUE},{id:'username',label:t('account.profile.username'),value:viewer.username??viewer.label},{id:'sign-in',label:t('account.profile.signIn'),value:t('account.profile.signInLocal')},{id:'roles',label:t('account.profile.roles'),value:rolesOf(viewer,t('account.profile.noRole'))}]}/>
    </div>
  </Card>;
}

/** The one card of an account from Microsoft Entra ID: profile facts, and the tenant and object ID behind "Details". */
export function EntraProfileCard({viewer}:{viewer:Viewer}){
  // Names follow lib/account-display.ts: never entra.<oid>, the .serverdesk.invalid address or the principal.
  const t=useT(),entra=viewer.entra,name=accountName(viewerNameParts(viewer)),email=accountDetail({identitySource:'entra',email:entra?.email});
  const copy=(value:string|undefined,label:string)=>value?<CopyValue value={value} label={label}/>:EMPTY_VALUE;
  return <Card title={t('account.profile.title')} id="account-profile-title" description={t('account.entraHint')} className="sdx-account-profile">
    <div className="sdx-account-identity"><span className="sdx-avatar" aria-hidden="true">{initialsOf(name)}</span>
      <Facts items={[{id:'name',label:t('account.profile.name'),value:name||EMPTY_VALUE},{id:'email',label:t('account.profile.email'),value:email||EMPTY_VALUE},{id:'sign-in',label:t('account.profile.signIn'),value:t('account.profile.signInEntra')},{id:'roles',label:t('account.profile.roles'),value:rolesOf(viewer,t('account.profile.noRole'))}]}/>
    </div>
    <Disclosure title={t('account.profile.details')} className="sdx-account-details">
      <Facts stacked items={[{id:'tenant',label:t('account.entraTenant'),value:copy(entra?.tenantId,t('account.copyTenant'))},{id:'object',label:t('account.entraObject'),value:copy(entra?.objectId,t('account.copyObject'))}]}/>
    </Disclosure>
  </Card>;
}

/**
 * The card "Sign-in & security" of a Nodiverna account. Its head is the page's focal point: the
 * protection state as a StatusPill and the passkey and authenticator counts. Below it the four methods:
 * Password, Passkeys, Authenticator apps and Recovery codes. Changes that need a fresh proof open the
 * step-up (MfaStepUp) first; successes confirm with a toast.
 */
export function SignInSecurityCard({viewer,frame}:{viewer:Viewer;/** A change of frame.refresh loads the methods again; the loaded ones stay shown. */frame?:PageFrame}){
  const[status,setStatus]=useState<MfaStatus|null>(null),[setup,setSetup]=useState<AuthenticatorSetup|null>(null),[editor,setEditor]=useState<AuthenticatorEditor|null>(null),[name,setName]=useState(''),[codes,setCodes]=useState<string[]>([]),[code,setCode]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState(''),[editorError,setEditorError]=useState(''),[stepUp,setStepUp]=useState(false),[management,setManagement]=useState<ManagementIntent|null>(null);
  const[passkeyRevision,setPasskeyRevision]=useState(0),[running,setRunning]=useState('');
  const t=useT(),stableT=useStableT(),[locale]=useLocale();
  const mounted=useRef(false),generation=useRef(0),loadSequence=useRef(0),loadAbort=useRef<AbortController|null>(null),pendingPasskey=useRef<((proof:ManagementProof)=>void)|null>(null),pendingPasswordCancel=useRef<(()=>void)|null>(null);
  const invalidatePending=useCallback(()=>{generation.current++;loadSequence.current++;loadAbort.current?.abort();},[]);
  const clear=useCallback(()=>{invalidatePending();pendingPasskey.current=null;pendingPasswordCancel.current?.();pendingPasswordCancel.current=null;setStatus(null);setSetup(null);setEditor(null);setManagement(null);setCodes([]);setCode('');setStepUp(false);setBusy(false);setLoading(false);},[invalidatePending]);
  const load=useCallback(async()=>{
    if(!mounted.current)return;
    const currentGeneration=generation.current,sequence=++loadSequence.current,controller=new AbortController();loadAbort.current?.abort();loadAbort.current=controller;setLoading(true);
    const timeout=setTimeout(()=>controller.abort(new Error(stableT('account.loadTimeout'))),15000);
    try{const next=await api<MfaStatus>('/api/mfa',undefined,controller.signal);if(mounted.current&&generation.current===currentGeneration&&loadSequence.current===sequence){setStatus(next);setLoadError('');}}
    catch(e){if(mounted.current&&generation.current===currentGeneration&&loadSequence.current===sequence){if(e instanceof ApiError&&(e.status===401||e.status===403))clear();setLoadError(message(e));}}
    finally{clearTimeout(timeout);if(loadAbort.current===controller)loadAbort.current=null;if(mounted.current&&generation.current===currentGeneration&&loadSequence.current===sequence)setLoading(false);}
  },[clear,stableT]);
  useFrameRefresh(frame,load);
  useEffect(()=>{
    mounted.current=true;
    const invalidate=()=>clear();window.addEventListener(SESSION_LOCK_EVENT,invalidate);
    void Promise.resolve().then(load);
    return()=>{mounted.current=false;invalidatePending();window.removeEventListener(SESSION_LOCK_EVENT,invalidate);};
  },[load,clear,invalidatePending]);
  // A failure shows in the open drawer; without one (removal, new codes) as a toast.
  const mutate=async(body:Record<string,unknown>,onDone?:(result:AuthenticatorSetup&{recoveryCodes?:string[]})=>void)=>{
    if(busy)return;
    const currentGeneration=++generation.current,inDrawer=!!editor&&editor.mode!=='delete';loadAbort.current?.abort();setLoading(false);setBusy(true);setRunning(String(body.action));setEditorError('');
    try{
      const result=await api<AuthenticatorSetup&{recoveryCodes?:string[]}>('/api/mfa',body);
      if(!mounted.current||generation.current!==currentGeneration)return;
      onDone?.(result);
      if(result.recoveryCodes){setCodes(result.recoveryCodes);toast.success(t('account.newCodesCreated'));}
      if(body.action==='authenticator-confirm'||body.action==='authenticator-delete')window.dispatchEvent(new Event(SESSION_SYNC_EVENT));
      await load();
    }catch(e){if(mounted.current&&generation.current===currentGeneration){if(inDrawer)setEditorError(message(e));else toast.error(message(e));}}
    finally{if(mounted.current&&generation.current===currentGeneration){setBusy(false);setRunning('');}}
  };
  const openEditor=(next:AuthenticatorEditor)=>{setEditorError('');setSetup(null);setCode('');setName(next.entry?.name??t('account.defaultAuthenticatorName'));setEditor(next);};
  // Closing the drawer during the second step cancels the pending challenge.
  const closeEditor=()=>{
    if(busy)return;
    const challengeId=setup?.challengeId;
    setEditor(null);setSetup(null);setCode('');setEditorError('');
    if(challengeId)void api('/api/mfa',{action:'authenticator-cancel',challengeId}).catch(()=>{});
  };
  const startEnrollment=()=>{
    if(!editor||busy||!name.trim())return;
    const selected=editor,chosenName=name.trim();
    if(!status?.enabled){void mutate({action:'begin'},result=>{setSetup(result);});return;}
    setManagement({action:'begin',editor:selected,name:chosenName});setEditor(null);setStepUp(true);
  };
  const confirmEnrollment=()=>{
    if(!setup||!/^\d{6}$/.test(code)||busy)return;
    const reset=editor?.mode==='reset';
    void mutate(setup.challengeId?{action:'authenticator-confirm',challengeId:setup.challengeId,code}:{action:'confirm',code},()=>{setEditor(null);setSetup(null);setCode('');toast.success(reset?t('account.authenticatorReset'):t('account.authenticatorAdded'));});
  };
  const submitEditor=(event:FormEvent)=>{
    event.preventDefault();
    if(!editor||busy)return;
    if(editor.mode==='rename'){const entry=editor.entry;if(entry&&name.trim()&&name.trim()!==entry.name)void mutate({action:'authenticator-rename',id:entry.id,name:name.trim()},()=>{setEditor(null);toast.success(t('account.authenticatorRenamed'));});}
    else if(setup)confirmEnrollment();else startEnrollment();
  };
  const confirmRemoval=()=>{if(editor?.mode!=='delete'||busy)return;setManagement({action:'delete',editor,name});setEditor(null);setStepUp(true);};
  const handleVerified=(proof:ManagementProof)=>{
    const intent=management,passkeyCallback=pendingPasskey.current;pendingPasskey.current=null;pendingPasswordCancel.current=null;setManagement(null);void load();setPasskeyRevision(value=>value+1);passkeyCallback?.(proof);
    if(!intent)return;
    if(!proof.managementToken){toast.error(t('mfa.missingProof'));return;}
    if(intent.action==='recovery')void mutate({action:'regenerate-recovery',managementToken:proof.managementToken});
    else if(intent.action==='delete')void mutate({action:'authenticator-delete',id:intent.editor.entry?.id,managementToken:proof.managementToken},()=>{toast.success(t('account.authenticatorRemoved'));});
    else void mutate({action:'authenticator-begin',...(intent.editor.mode==='reset'?{id:intent.editor.entry?.id}:{}),name:intent.name,managementToken:proof.managementToken},result=>{setEditor(intent.editor);setName(intent.name);setSetup(result);setCode('');});
  };
  const confirmIdentity=()=>{setManagement(null);setStepUp(true);};
  const authenticators=status?.authenticators??[];
  // At least one passkey or authenticator remains; a passkey-only account shows no active app.
  // Passkeys count only where they can be used (server rule in deleteAuthenticator);
  // without passkeysAvailable in the status the last app stays.
  const lastFactor=!!status&&status.authenticatorCount+(status.passkeyCount??0)<=1,authenticatorActive=!!status?.enabled&&status.authenticatorCount>0;
  const lastUsableFactor=!!status&&status.authenticatorCount<=1&&(status.passkeyCount??0)>0&&status.passkeysAvailable!==true;
  const deleteBlocked=lastFactor?t('passkeys.lastFactor'):lastUsableFactor?t('account.passkeysUnusable'):undefined;
  // Why a change cannot run now: not available, identity not confirmed, another change runs.
  const unavailable=!!status&&!status.available,unconfirmed=!!status?.enabled&&!status.authenticated;
  const changeBlocked=!status?t('account.loadingMethods'):unavailable?t('account.unavailable'):unconfirmed?t('account.blocked.confirm'):busy?t('kit.busy'):undefined;
  const addBlocked=(!status?.enabled&&status?.available&&!busy?undefined:changeBlocked)??(status&&status.authenticatorCount>=status.maximumAuthenticators?t('account.blocked.maximum',{count:status.maximumAuthenticators}):undefined);
  const codesBlocked=!status?.enabled?t('account.blocked.codesNeedMfa'):unavailable?t('account.unavailable'):busy?t('kit.busy'):undefined;
  const state:{kind:StatusKind;tone:IconTone;label:string}|null=!status?null:!status.available?{kind:'neutral',tone:'neutral',label:t('common.notAvailable')}:status.enabled?{kind:'success',tone:'success',label:t('account.status.protected')}:{kind:'warning',tone:'warning',label:t('account.status.setupNeeded')};
  const counts=status?`${t('passkeys.count',{count:status.passkeyCount??0})} · ${t('account.authenticatorCount',{count:status.authenticatorCount})}`:undefined;
  const drawerOpen=!!editor&&editor.mode!=='delete',removing=editor?.mode==='delete'?editor.entry:undefined;
  const drawerTitle=editor?.mode==='rename'?t('account.title.rename'):editor?.mode==='reset'?t('account.title.reset'):t('account.addAuthenticator');
  const drawerIntro=setup?t('account.setupIntro'):editor?.mode==='reset'?t('account.resetIntro'):editor?.mode==='rename'?t('account.renameIntro'):t('account.addIntro');
  const submitLabel=editor?.mode==='rename'?t('account.rename'):setup?editor?.mode==='reset'?t('account.confirmReset'):t('account.activateAuthenticator'):t('common.continue');
  const submitBlocked=setup?(/^\d{6}$/.test(code)?undefined:t('session.codeBlocked')):(status?.enabled||editor?.mode==='rename')&&!name.trim()?t('account.blocked.name'):editor?.mode==='rename'&&name.trim()===editor.entry?.name?t('common.noChanges'):undefined;
  const drawerDirty=setup?code.length>0:name.trim()!==(editor?.entry?.name??t('account.defaultAuthenticatorName'));
  return <Card title={t('account.security')} id="account-security-title" icon={ShieldCheck} iconTone={state?.tone??'accent'} meta={counts} className="sdx-account-security"
    actions={state&&<StatusPill kind={state.kind}>{state.label}</StatusPill>}>
    {!status&&loading&&<Skeleton variant="facts" label={t('account.loadingMethods')} after={15000} action={<RetryAction onRetry={()=>void load()}/>}/>}
    {loadError&&!loading&&<LoadFailed text={status?`${loadError} ${t('account.staleShown')}`:loadError} onRetry={()=>void load()}/>}
    {unavailable&&<Notice tone="warning" icon={AlertTriangle}>{t('account.unavailable')}</Notice>}
    {status&&unconfirmed&&!unavailable&&<Notice tone="info" icon={Lock} action={<Btn size="sm" icon={Lock} onClick={confirmIdentity}>{t('passkeys.confirmIdentity')}</Btn>}>{t('account.confirmToManage')}</Notice>}
    {status&&<div className="sdx-account-methods">
      <PasswordSettings viewer={viewer} blocked={unavailable?t('account.unavailable'):!status.authenticated?t('account.blocked.confirm'):undefined} onConfirmIdentity={(verified,cancelled)=>{pendingPasskey.current=verified;pendingPasswordCancel.current=cancelled;setManagement(null);setStepUp(true);}}/>
      <PasskeysPanel mfaEnabled={!!status.enabled} blocked={unavailable?t('account.unavailable'):unconfirmed?t('account.blocked.confirm'):undefined} onConfirmIdentity={afterVerify=>{pendingPasskey.current=afterVerify??null;setManagement(null);setStepUp(true);}} reloadKey={passkeyRevision} onChanged={()=>void load()}/>
      <MethodSection id="account-authenticator-title" icon={KeyRound} title={t('account.authenticatorApps')} description={t('account.sixDigit')}
        state={<StatusPill size="sm" kind={authenticatorActive?'success':'neutral'}>{authenticatorActive?t('account.active'):t('account.notSetUp')}</StatusPill>}
        actions={<Btn size="sm" icon={Plus} blocked={addBlocked} onClick={()=>openEditor({mode:'add'})}>{status.enabled?t('account.addAuthenticator'):t('account.setUp')}</Btn>}>
        {authenticators.length>0&&<ul className="sdx-account-list">{authenticators.map(entry=><li key={entry.id} className="sdx-account-row">
          <IconTile icon={KeyRound} tone="neutral" size="sm"/>
          <div className="sdx-account-row-text"><strong>{entry.name}</strong><small>{t('account.created',{time:stamp(entry.createdAt,locale)})}{entry.lastUsedAt&&t('account.lastUsed',{time:stamp(entry.lastUsedAt,locale)})}</small></div>
          <Menu label={t('account.rowActions',{name:entry.name})} entries={[
            {id:'rename',label:t('account.rename'),icon:Pencil,blocked:changeBlocked,onSelect:()=>openEditor({mode:'rename',entry})},
            {id:'reset',label:t('account.reset'),icon:RefreshCw,blocked:changeBlocked,onSelect:()=>openEditor({mode:'reset',entry})},
            {id:'separator',separator:true},
            {id:'remove',label:t('account.removeAuthenticator'),icon:Trash2,danger:true,blocked:changeBlocked??deleteBlocked,onSelect:()=>openEditor({mode:'delete',entry})},
          ]}/>
        </li>)}</ul>}
      </MethodSection>
      <MethodSection id="account-recovery-title" icon={LifeBuoy} title={t('session.title.recoveryCodes')} description={t('account.recoveryHint')}
        actions={<Btn size="sm" icon={RefreshCw} blocked={codesBlocked} loading={running==='regenerate-recovery'} onClick={()=>{setManagement({action:'recovery'});setStepUp(true);}}>{t('account.newCodes')}</Btn>}>
        {codes.length>0&&<div className="sdx-account-codes">
          <p role="status">{t('account.codesNote')}</p>
          <span className="sdx-field-label">{t('account.codesLabel')}</span>
          <CopyValue value={codes.join('\n')} label={t('account.copyCodes')} success={t('account.codesCopied')} display={<ul className="sdx-account-code-list mono">{codes.map(value=><li key={value}>{value}</li>)}</ul>}/>
          <div className="sdx-account-code-actions"><Btn size="sm" icon={Download} onClick={()=>downloadText('ServerDesk-Recovery-Codes.txt',codes.join('\n'),'text/plain')}>{t('account.saveCodes')}</Btn><Btn size="sm" variant="ghost" onClick={()=>setCodes([])}>{t('account.hide')}</Btn></div>
        </div>}
      </MethodSection>
    </div>}
    <Drawer open={drawerOpen} onClose={closeEditor} title={drawerTitle} description={drawerIntro} icon={KeyRound} dirty={drawerDirty&&!busy}
      footer={<><DrawerCancel/><Btn variant="primary" type="submit" form="account-authenticator-form" loading={busy} blocked={submitBlocked}>{submitLabel}</Btn></>}>
      <form id="account-authenticator-form" className="sdx-form-grid" onSubmit={submitEditor}>
        {!setup&&(status?.enabled||editor?.mode==='rename')&&<Field label={t('common.name')}><input id="account-authenticator-name" autoFocus value={name} maxLength={80} placeholder={t('account.namePlaceholder')} onChange={event=>setName(event.target.value)}/></Field>}
        {setup&&<>
          <MfaQrCode uri={setup.uri} expiresAt={setup.expiresAt}/>
          <div className="sdx-account-setup-key"><span className="sdx-field-label">{t('session.setupKey')}</span><CopyValue value={setup.secret} label={t('session.copySetupKey')} success={t('session.setupKeyCopied')}/></div>
          <p className="sdx-account-setup-links"><a href={setup.uri}>{t('session.openAuthenticator')}</a><small>{t('account.validUntil',{time:stamp(setup.expiresAt,locale)})}</small></p>
          <Field label={t('account.newEntryCode')}><input id="account-authenticator-code" className="mono" autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000" value={code} onChange={event=>setCode(event.target.value.replace(/\D/g,''))}/></Field>
        </>}
        {editorError&&<Notice tone="danger" icon={AlertTriangle}>{editorError}</Notice>}
      </form>
    </Drawer>
    <ConfirmDialog open={!!removing} onOpenChange={open=>{if(!open&&!busy)setEditor(null);}} tone="danger" title={t('account.title.remove')} lines={removing?[{label:t('common.name'),value:removing.name}]:undefined}
      body={removing?t('account.removeIntro',{name:removing.name}):undefined} confirmLabel={t('account.removeAuthenticator')} onConfirm={confirmRemoval}/>
    <MfaStepUp open={stepUp} onClose={()=>{pendingPasskey.current=null;pendingPasswordCancel.current?.();pendingPasswordCancel.current=null;setStepUp(false);setManagement(null);}} onVerified={handleVerified}/>
  </Card>;
}

