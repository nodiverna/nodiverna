'use client';
// Create a runbook or a new version of one (shown inside RunbookPanel): the basics, the parameter
// JSON, and up to 30 steps with their diagnosis or PowerShell code and requirements. Kit Field,
// select.sdx-select and Btn; "Save version" is the primary and says why it is blocked.
import {useId,useState} from 'react';
import {AlertTriangle,ArrowDown,ArrowLeft,ArrowUp,Plus,Save,Trash2} from 'lucide-react';
import {operations} from '@/lib/management';
import {catalogOwnerFieldLabel,catalogOwnerHints} from '@/ui/base/catalog-owner';
import type {MessageKey} from '@/lib/i18n/translate';
import {Btn,IconBtn,Notice} from '@/ui/kit/kit';
import {Field,Select} from '@/ui/kit/field';
import '@/ui/base/catalog-owner.css';
import '@/ui/automation/runbooks.css';

import {useT} from '@/ui/base/locale';
export type RunbookStep={id:string;name:string;kind:'powershell'|'diagnosis';script?:string;operation?:string;operationParameters?:Record<string,unknown>;timeoutSeconds:number;preconditions?:{osFamily?:'server'|'windows11';domainJoined?:boolean;rebootPending?:boolean}};
type Props={
  existing:boolean;name:string;description:string;steps:RunbookStep[];parameterSpec:string;busy:boolean;error:string;
  onNameChange:(name:string)=>void;onDescriptionChange:(description:string)=>void;onStepsChange:(steps:RunbookStep[])=>void;
  onParameterSpecChange:(spec:string)=>void;onTemplate:(template:string)=>void;onCancel:()=>void;onSave:()=>void;
  /** Owner choices for a new runbook once catalogs are separated, else null. */
  ownerChoices?:{value:string;label:string}[]|null;owner?:string;onOwnerChange?:(owner:string)=>void;
  /** "Gehört zu: …" for a new version once catalogs are separated. */
  ownerText?:string;
};
const diagnoses:{value:string;label:MessageKey}[]=[{value:'refresh',label:'management.action.refresh'},{value:'scan-updates',label:'runbooks.diagnosis.scanUpdates'},{value:'test-connection',label:'runbooks.diagnosis.testConnection'}];
const maxSteps=30;
export default function RunbookEditor({existing,name,description,steps,parameterSpec,busy,error,onNameChange,onDescriptionChange,onStepsChange,onParameterSpecChange,onTemplate,onCancel,onSave,ownerChoices=null,owner='',onOwnerChange,ownerText}:Props){
  const t=useT();
  const uid=useId();
  const[template,setTemplate]=useState('');
  let parameterError='',hasParameters=false;try{const parsed=JSON.parse(parameterSpec);if(!Array.isArray(parsed))parameterError=t('runbooks.params.notList');else hasParameters=parsed.length>0;}catch{parameterError=t('runbooks.params.invalid');}
  const showParameters=steps.some(step=>step.kind==='powershell')||hasParameters||!!parameterError;
  const diagnosticErrors:Record<string,{host?:string;port?:string;form?:string}>={};
  for(const step of steps){
    if(step.kind!=='diagnosis')continue;
    const result=operations[step.operation??'']?.schema.safeParse(step.operationParameters??{});
    if(result?.success)continue;
    const errors:{host?:string;port?:string;form?:string}={};
    for(const issue of result?.error.issues??[]){
      if(issue.path[0]==='host')errors.host=t('runbooks.host.invalid');
      else if(issue.path[0]==='port')errors.port=t('runbooks.port.invalid');
      else errors.form=t('runbooks.diagnosis.again');
    }
    if(!result)errors.form=t('runbooks.diagnosis.choose');
    diagnosticErrors[step.id]=errors;
  }
  const updateStep=(index:number,change:Partial<RunbookStep>)=>onStepsChange(steps.map((step,i)=>i===index?{...step,...change}:step));
  const moveStep=(index:number,direction:-1|1)=>{const next=[...steps];[next[index],next[index+direction]]=[next[index+direction],next[index]];onStepsChange(next);};
  const firstDiagnostic=Object.values(diagnosticErrors).flatMap(errors=>[errors.host,errors.port,errors.form]).find(Boolean);
  // Why "Save version" cannot run: no name, no steps, an invalid parameter list or diagnosis, or a running save.
  const saveReason=!name.trim()?t('runbooks.blocked.nameRequired'):!steps.length?t('runbooks.blocked.onlyStep'):parameterError||firstDiagnostic||(busy?t('automation.busy'):undefined);
  const busyReason=busy?t('automation.busy'):undefined;
  const actions=<div className="rb-editor-actions"><Btn onClick={onCancel} disabled={busy}>{t('common.cancel')}</Btn><Btn variant="primary" type="submit" icon={Save} loading={busy} blocked={saveReason&&!busy?saveReason:undefined}>{t('runbooks.saveVersion')}</Btn></div>;
  return <form className="sdx-card rb-editor" onSubmit={event=>{event.preventDefault();if(!busy&&name.trim()&&steps.length&&!parameterError&&!firstDiagnostic)onSave();}}>
    <header className="rb-editor-head">
      <IconBtn icon={ArrowLeft} label={t('runbooks.backToList')} blocked={busyReason} onClick={onCancel}/>
      <div className="rb-editor-title"><h3>{existing?t('runbooks.newVersion'):t('runbooks.create')}</h3><p>{existing?t('runbooks.previousKept'):t('runbooks.createHint')}</p></div>
      {actions}
    </header>
    {error&&<Notice tone="danger" icon={AlertTriangle}>{error}</Notice>}
    <div className="rb-editor-layout">
      <fieldset className="rb-fieldset rb-editor-section"><legend>{t('runbooks.basics')}</legend>
        <Field label={t('runbooks.template')}><Select disabled={busy} value={template} onChange={event=>{const value=event.target.value;setTemplate(value);onTemplate(value);}}><option value="">{t('runbooks.custom')}</option><option value="health">{t('runbooks.template.health')}</option><option value="updates">{t('runbooks.template.updates')}</option><option value="dns">{t('runbooks.template.dns')}</option><option value="services">{t('runbooks.template.services')}</option><option value="maintenance">{t('runbooks.template.serviceMaintenance')}</option></Select></Field>
        <Field label={t('common.name')}><input value={name} onChange={event=>onNameChange(event.target.value)} maxLength={120} required disabled={busy}/></Field>
        <Field label={t('common.description')}><textarea value={description} onChange={event=>onDescriptionChange(event.target.value)} maxLength={1000} rows={3} disabled={busy} placeholder={t('runbooks.descriptionPlaceholder')}/></Field>
        {!existing&&ownerChoices&&<Field label={t(catalogOwnerFieldLabel)} hint={t(catalogOwnerHints.runbook)}><Select value={owner} disabled={busy} onChange={event=>onOwnerChange?.(event.target.value)}>{ownerChoices.map(choice=><option key={choice.value} value={choice.value}>{choice.label}</option>)}</Select></Field>}
        {existing&&ownerText&&<p className="rb-help">{ownerText}</p>}
      </fieldset>
      {showParameters&&<fieldset className="rb-fieldset rb-editor-section"><legend>{t('runbooks.params.title')}</legend>
        <Field label={t('runbooks.params.json')} hint={t('runbooks.params.help')} error={parameterError}><textarea className="rb-code" rows={9} value={parameterSpec} onChange={event=>onParameterSpecChange(event.target.value)} disabled={busy} spellCheck={false} placeholder='[{"name":"hostname","type":"string","required":true,"secret":false}]'/></Field>
      </fieldset>}
    </div>
    <section className="rb-editor-steps" aria-labelledby={uid+'-steps'}>
      <div className="rb-editor-step-head"><h4 id={uid+'-steps'}>{t('jobs.table.steps')} <span className="rb-help">{steps.length} / {maxSteps}</span></h4><Btn size="sm" icon={Plus} blocked={steps.length>=maxSteps?t('runbooks.blocked.maxSteps'):busyReason} onClick={()=>onStepsChange([...steps,{id:'step_'+crypto.randomUUID().replaceAll('-','').slice(0,12),name:t('runbooks.step.new'),kind:'diagnosis',operation:'refresh',operationParameters:{},timeoutSeconds:60}])}>{t('runbooks.step.add')}</Btn></div>
      {steps.map((step,index)=>{
        const errors=diagnosticErrors[step.id];
        return <fieldset className="rb-fieldset rb-editor-section" key={step.id}>
          <legend>{t('runbooks.step.number',{value:index+1})}</legend>
          <div className="rb-editor-step-head"><strong>{step.name||t('runbooks.step.unnamed')}</strong><div className="rb-editor-actions">
            <IconBtn icon={ArrowUp} label={t('runbooks.step.moveUp',{step:index+1})} blocked={index===0?t('runbooks.blocked.firstStep'):busyReason} onClick={()=>moveStep(index,-1)}/>
            <IconBtn icon={ArrowDown} label={t('runbooks.step.moveDown',{step:index+1})} blocked={index===steps.length-1?t('runbooks.blocked.lastStep'):busyReason} onClick={()=>moveStep(index,1)}/>
            <Btn variant="ghost" size="sm" icon={Trash2} blocked={steps.length===1?t('runbooks.blocked.onlyStep'):busyReason} onClick={()=>onStepsChange(steps.filter((_,i)=>i!==index))}>{t('common.remove')}</Btn>
          </div></div>
          <div className="rb-editor-step-grid">
            <Field label={t('runbooks.step.name')}><input value={step.name} disabled={busy} onChange={event=>updateStep(index,{name:event.target.value})} required/></Field>
            <Field label={t('runbooks.step.kind')}><Select value={step.kind} disabled={busy} onChange={event=>{const kind=event.target.value as RunbookStep['kind'];onStepsChange(steps.map((current,i)=>i===index?{id:current.id,name:current.name,timeoutSeconds:current.timeoutSeconds,preconditions:current.preconditions,kind,...(kind==='diagnosis'?{operation:'refresh',operationParameters:{}}:{script:''})}:current));}}><option value="diagnosis">{t('runbooks.step.fixed')}</option><option value="powershell">{t('runbooks.step.powershell')}</option></Select></Field>
            <Field label={t('runbooks.step.timeout')}><input type="number" min={5} max={3600} value={step.timeoutSeconds} disabled={busy} onChange={event=>updateStep(index,{timeoutSeconds:Number(event.target.value)})} required/></Field>
          </div>
          {step.kind==='powershell'?<Field label={t('runbooks.step.script')} hint={t('runbooks.step.systemNote')}><textarea className="rb-code" rows={12} value={step.script??''} disabled={busy} onChange={event=>updateStep(index,{script:event.target.value})} maxLength={32768} spellCheck={false} placeholder="Get-Service | Select-Object Name, Status"/></Field>:<>
            <Field label={t('runbooks.step.diagnosis')}><Select value={step.operation} disabled={busy} onChange={event=>{const operation=event.target.value;updateStep(index,{operation,operationParameters:operation==='test-connection'?{host:'',port:443}:{}});}}>{diagnoses.map(option=><option key={option.value} value={option.value}>{t(option.label)}</option>)}</Select></Field>
            {step.operation==='test-connection'&&<div className="rb-two">
              <Field label={t('runbooks.step.host')} error={errors?.host}><input value={typeof step.operationParameters?.host==='string'?step.operationParameters.host:''} disabled={busy} onChange={event=>updateStep(index,{operationParameters:{...step.operationParameters,host:event.target.value.trim()}})} placeholder="dc01.example.local" maxLength={253} required autoComplete="off" spellCheck={false}/></Field>
              <Field label={t('network.tcpPort')} error={errors?.port}><input type="number" min={1} max={65535} step={1} value={typeof step.operationParameters?.port==='number'?step.operationParameters.port:''} disabled={busy} onChange={event=>updateStep(index,{operationParameters:{...step.operationParameters,port:event.target.value===''?undefined:Number(event.target.value)}})} required/></Field>
            </div>}
            {errors?.form&&<p className="sdx-field-error" role="alert">{errors.form}</p>}
          </>}
          <details className="v3-disclosure"><summary>{t('runbooks.requirements')}</summary><div className="rb-editor-conditions">
            <Field label={t('fleet.col.os')}><Select value={step.preconditions?.osFamily??''} disabled={busy} onChange={event=>updateStep(index,{preconditions:{...step.preconditions,osFamily:event.target.value?event.target.value as 'server'|'windows11':undefined}})}><option value="">{t('runbooks.any')}</option><option value="server">{t('fleet.type.server')}</option><option value="windows11">{t('fleet.type.client')}</option></Select></Field>
            <Field label={t('management.domainMembership')}><Select value={step.preconditions?.domainJoined===undefined?'':String(step.preconditions.domainJoined)} disabled={busy} onChange={event=>updateStep(index,{preconditions:{...step.preconditions,domainJoined:event.target.value?event.target.value==='true':undefined}})}><option value="">{t('runbooks.any')}</option><option value="true">{t('runbooks.domainJoined')}</option><option value="false">{t('management.param.workgroup')}</option></Select></Field>
            <Field label={t('device.issue.reboot')}><Select value={step.preconditions?.rebootPending===undefined?'':String(step.preconditions.rebootPending)} disabled={busy} onChange={event=>updateStep(index,{preconditions:{...step.preconditions,rebootPending:event.target.value?event.target.value==='true':undefined}})}><option value="">{t('runbooks.any')}</option><option value="true">{t('management.yes')}</option><option value="false">{t('management.no')}</option></Select></Field>
          </div></details>
        </fieldset>;
      })}
    </section>
    <footer className="rb-editor-foot"><span className="rb-help">{t(steps.some(step=>step.kind==='powershell')?'runbooks.footer.management':'runbooks.footer.readOnly',{count:steps.length})}</span>{actions}</footer>
  </form>;
}
