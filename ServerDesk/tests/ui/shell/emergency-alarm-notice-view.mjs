// The Owner notice "Emergency access was used" with the real
// ui/shell/emergency-alarm-notice.tsx and kit.tsx, in English and German
// (harness as in tests/ui/shell/previous-secret-notice-view.mjs, with a small state
// hook for the optimistic hide): title, text with the relative and exact time,
// the "more" line, the audit link, Acknowledge (blocked for the account's own
// sign-in), the request, the toast, the rollback on an error, nothing without
// an open alarm, and the place in the console outside demo mode.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {i18nStubs,i18nRequire,localeHooks,translateModule,apiErrorTextModule} from '../../support/i18n-stubs.mjs';

let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
const jsx=(type,props,key)=>({type,props:props??{},key});
const source=filename=>ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
const icons=new Proxy({}, {get:(_target,key)=>String(key)});
function load(filename,stubs={}){
 const mod={exports:{}};
 const require=id=>Object.hasOwn(stubs,id)?stubs[id]:i18nRequire(id)??(id==='react/jsx-runtime'?{jsx,jsxs:jsx,Fragment:'Fragment'}:id==='lucide-react'?icons:(()=>{throw Error('Unexpected import '+id+' in '+filename);})());
 new Function('require','module','exports',source(path.resolve(filename)))(require,mod,mod.exports);
 return mod.exports;
}
// One component at a time: useState keeps its slots between renders of the same mount.
let slots=[],slot=0;
const react={useState:initial=>{const index=slot++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return [slots[index],next=>{slots[index]=typeof next==='function'?next(slots[index]):next;}];},forwardRef:render=>render};
const kit=load('ui/kit/kit.tsx',{...i18nStubs,react:{forwardRef:render=>render,createContext:()=>({Provider:'Provider'})},'radix-ui':{Dialog:{},DropdownMenu:{}},recharts:{},'@/ui/kit/tooltip':{Tooltip:({children})=>children},'@/ui/kit/chart':load('ui/kit/chart.ts'),'@/ui/kit/focus-return':load('ui/kit/focus-return.ts'),'@/ui/kit/confirm-dialog':{ConfirmDialog:'ConfirmDialog'},'@/ui/kit/overflow-focusable':{useScrollEdges:()=>({start:false,end:false}),useOverflowFocusable:()=>[{current:null},false]}});
const consoleRoute=load('lib/console-route.ts');
const requests=[],toasts=[];let reply=()=>({ok:true});
class ApiError extends Error{constructor(body){super(body.error);this.body=body;}}
const shared={api:async(url,body)=>{requests.push({url,body});const result=reply();if(result instanceof Error)throw result;return result;},message:(failure,locale)=>apiErrorTextModule.apiErrorText(locale,failure.body)};
const sonner={toast:{success:text=>toasts.push(['success',text]),error:text=>toasts.push(['error',text])}};
const notice=locale=>load('ui/shell/emergency-alarm-notice.tsx',{react,sonner,'@/ui/base/api':shared,'@/lib/console-route':consoleRoute,'@/ui/kit/kit':kit,'@/ui/base/clock-store':{useClockNow:pinned=>pinned??Date.now()},'@/ui/base/locale':{...localeHooks,useLocale:()=>[locale,()=>{}],useT:()=>(key,params)=>translateModule.translate(locale,key,params)}});
const text=node=>typeof node==='string'?node:!node||typeof node!=='object'?'':[node.props?.children].flat(Infinity).map(text).join('');
const find=(node,predicate)=>{if(!node||typeof node!=='object')return null;if(Array.isArray(node)){for(const child of node){const hit=find(child,predicate);if(hit)return hit;}return null;}if(predicate(node))return node;return find(node.props?.children,predicate);};
const mount=(Component,props)=>{slots=[];const render=()=>{slot=0;return Component(props);};return render;};
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));

const now=Date.parse('2026-11-10T12:00:00Z'),at=now-5*60_000;
const latest={id:'11111111-2222-4333-8444-555555555555',at,displayName:'Break Glass',address:'203.0.113.9',own:false};
const copy={
 en:{title:'Emergency access was used',text:'Break Glass signed in with the emergency access {rel} from 203.0.113.9.',unknown:'Break Glass signed in with the emergency access {rel} from an unknown address.',more:'2 more emergency sign-ins are not acknowledged yet.',one:'1 more emergency sign-in is not acknowledged yet.',audit:'Open audit log',acknowledge:'Acknowledge',own:'Another Owner must acknowledge this alarm.',done:'Alarm acknowledged.'},
 de:{title:'Der Notfallzugang wurde benutzt',text:'Break Glass hat sich {rel} von 203.0.113.9 mit dem Notfallzugang angemeldet.',unknown:'Break Glass hat sich {rel} von einer unbekannten Adresse mit dem Notfallzugang angemeldet.',more:'2 weitere Notfall-Anmeldungen sind noch nicht zur Kenntnis genommen.',one:'1 weitere Notfall-Anmeldung ist noch nicht zur Kenntnis genommen.',audit:'Protokoll öffnen',acknowledge:'Zur Kenntnis nehmen',own:'Ein anderer Owner muss diesen Alarm zur Kenntnis nehmen.',done:'Alarm zur Kenntnis genommen.'},
};
for(const [locale,phrases] of Object.entries(copy)){
 const expected=Object.fromEntries(Object.entries(phrases).map(([key,value])=>[key,value.replace('{rel}',kit.relativeTime(at,now,locale))]));
 const {default:EmergencyAlarmNotice,auditLogHash,securityAlarmsEndpoint}=notice(locale);
 // 1. Nothing without an open alarm (non-Owner: no field).
 for(const alarms of [undefined,{open:0,latest:null}])check(mount(EmergencyAlarmNotice,{alarms,now})(),null,`${locale}: no notice for ${JSON.stringify(alarms)}`);
 // 2. One open alarm: the danger notice with Siren, title, text, audit link and Acknowledge.
 const tree=mount(EmergencyAlarmNotice,{alarms:{open:1,latest},now})();
 check([tree.type,tree.props.tone,tree.props.icon],[kit.Notice,'danger','Siren'],`${locale}: a danger Notice (role alert) with the Siren icon`);
 const body=[tree.props.children].flat(Infinity);
 check([body[0].type,text(body[0])],['strong',expected.title],`${locale}: the bold title`);
 const sentence=body.find(node=>node?.type==='span');
 check([text(sentence),sentence.props.title],[expected.text,kit.exactTime(at,locale)],`${locale}: the text with the relative time; the exact time as title`);
 check(text(tree).includes(expected.one),false,`${locale}: no "more" line for one alarm`);
 const actions=tree.props.action,link=find(actions,node=>node.type==='a');
 check([link.props.href,link.props.className,text(link)],['#settings/audit','sdx-btn sdx-btn-ghost sdx-btn-sm',expected.audit],`${locale}: the audit log link`);
 check(auditLogHash,consoleRoute.consoleRouteHash({view:'settings',page:'audit'}),'the audit page route');
 const button=find(actions,node=>node.type===kit.Btn);
 check([text(button),button.props.blocked,button.props.icon],[expected.acknowledge,undefined,'CheckCheck'],`${locale}: Acknowledge, not blocked`);
 // 3. More alarms and an unknown address.
 const more=mount(EmergencyAlarmNotice,{alarms:{open:3,latest:{...latest,address:'unknown'}},now})();
 check([text([more.props.children].flat(Infinity).find(node=>node?.type==='span')),text(more).includes(expected.more)],[expected.unknown,true],`${locale}: the unknown address and the "more" line`);
 check(text(mount(EmergencyAlarmNotice,{alarms:{open:2,latest},now})()).includes(expected.one),true,`${locale}: one more`);
 // 4. The account's own sign-in: Acknowledge blocked with the server's reason, and nothing is sent.
 const own=mount(EmergencyAlarmNotice,{alarms:{open:1,latest:{...latest,own:true}},now});
 const ownButton=find(own().props.action,node=>node.type===kit.Btn);
 check(ownButton.props.blocked,expected.own,`${locale}: blocked with apiError.alarm.ownEmergency`);
 requests.length=0;await ownButton.props.onClick();check(requests.length,0,'a blocked acknowledge sends nothing');
 // 5. Acknowledge: hidden at once, the request, the toast, the refresh.
 let refreshed=0;requests.length=0;toasts.length=0;
 const render=mount(EmergencyAlarmNotice,{alarms:{open:1,latest},now,onAcknowledged:()=>refreshed++});
 const pending=find(render().props.action,node=>node.type===kit.Btn).props.onClick();
 check(render(),null,`${locale}: the notice hides at once`);
 await pending;await settle();
 check([requests,toasts,refreshed,render()],[[{url:securityAlarmsEndpoint,body:{action:'acknowledge',id:latest.id}}],[['success',expected.done]],1,null],`${locale}: POST /api/security-alarms, the toast and the refresh; it stays hidden`);
 // 6. A refusal brings it back with the error toast.
 reply=()=>new ApiError({error:'x',code:'SECURITY_ALARM_CHANGED',messageKey:'apiError.alarm.changed'});requests.length=0;toasts.length=0;refreshed=0;
 const failing=mount(EmergencyAlarmNotice,{alarms:{open:1,latest},now,onAcknowledged:()=>refreshed++});
 await find(failing().props.action,node=>node.type===kit.Btn).props.onClick();
 check([failing()?.props.tone,toasts,refreshed],['danger',[['error',apiErrorTextModule.apiErrorText(locale,{messageKey:'apiError.alarm.changed'})]],0],`${locale}: rolled back with the error toast`);
 reply=()=>({ok:true});
}

// 7. The console renders it after the previous-secret notice, outside demo mode, in every view.
const consoleSource=fs.readFileSync('ui/shell/console.tsx','utf8');
const main=consoleSource.slice(consoleSource.indexOf('<main id="console-content"'),consoleSource.indexOf('</main>'));
const previous=main.indexOf('{!demo&&<PreviousSecretNotice removable={data?.previousSecretRemovable}/>}'),emergency=main.indexOf('{!demo&&<EmergencyAlarmNotice alarms={data?.emergencyAlarms} onAcknowledged={()=>void refresh(true)}/>}');
check([previous>=0,emergency>previous],[true,true],'next to the previous-secret notice, hidden in demo mode, refreshes after acknowledge');
check(main.slice(previous,emergency).includes('view==='),false,'not bound to a view');
check((consoleSource.match(/<EmergencyAlarmNotice /g)??[]).length,1,'rendered once');
console.log(`PASS ${checks} emergency alarm notice checks: nothing without an open alarm, exact EN and DE copy, danger with Siren, the more line, the audit link, Acknowledge blocked for the own sign-in, optimistic hide with toast and rollback, position in the console.`);
