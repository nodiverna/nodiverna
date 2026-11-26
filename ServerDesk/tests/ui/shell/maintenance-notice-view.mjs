// The Owner notice "Wartung noch nicht gelaufen / überfällig" with the
// real ui/shell/maintenance-notice.tsx and kit.tsx (harness as in
// tests/ui/settings/usage-consent-dialog.mjs). No server or browser is touched.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {i18nStubs,i18nRequire} from '../../support/i18n-stubs.mjs';

let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
const jsx=(type,props,key)=>({type,props:props??{},key});
const source=filename=>ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
const icons=new Proxy({}, {get:(_target,key)=>String(key)});
function load(filename,stubs={}){
 const mod={exports:{}};
 const require=id=>i18nRequire(id)??(Object.hasOwn(stubs,id)?stubs[id]:id==='react/jsx-runtime'?{jsx,jsxs:jsx,Fragment:'Fragment'}:id==='lucide-react'?icons:(()=>{throw Error('Unexpected import '+id+' in '+filename);})());
 new Function('require','module','exports',source(path.resolve(filename)))(require,mod,mod.exports);
 return mod.exports;
}
const kit=load('ui/kit/kit.tsx',{...i18nStubs,react:{forwardRef:render=>render,createContext:()=>({Provider:'Provider'})},'radix-ui':{Dialog:{},DropdownMenu:{}},recharts:{},'@/ui/kit/tooltip':{Tooltip:({children})=>children},'@/ui/kit/chart':load('ui/kit/chart.ts'),'@/ui/kit/focus-return':load('ui/kit/focus-return.ts'),'@/ui/kit/confirm-dialog':{ConfirmDialog:'ConfirmDialog'},'@/ui/kit/overflow-focusable':{useScrollEdges:()=>({start:false,end:false}),useOverflowFocusable:()=>[{current:null},false]}});
// The console clock: the time a test pins, else the wall clock.
const notice=load('ui/shell/maintenance-notice.tsx',{'@/lib/console-route':load('lib/console-route.ts'),'@/ui/kit/kit':kit,'@/ui/base/clock-store':{useClockNow:pinned=>pinned??Date.now()}});
const {maintenanceNoticeText,default:MaintenanceNotice}=notice;

const day=86_400_000,now=Date.UTC(2026,9,22,12);
const never={lastSuccessAt:null,lastRun:null,stale:true};
const overdue={lastSuccessAt:now-3*day,lastRun:{startedAt:now-3*day-1000,finishedAt:now-3*day,status:'succeeded'},stale:true};
const failedRun={startedAt:now-day,finishedAt:now-day+1000,status:'failed'};
const consequence='werden alte Audit-Einträge und Dateiübertragungen nicht gelöscht, und es wird kein Nutzungsbericht gesendet.';
const failedText=' Der letzte Lauf ist fehlgeschlagen. Den Grund siehst du unter Einstellungen → Datenaufbewahrung.';

// 1. The exact UI copy of the notice.
check(maintenanceNoticeText(never,now),{title:'Die tägliche Bereinigung ist noch nicht gelaufen.',text:`Die tägliche Bereinigung ist auf dieser Installation noch nie fertig geworden. Bis sie läuft, ${consequence} Öffne Einstellungen → Datenaufbewahrung, um sie jetzt zu starten.`},'(a) never');
check(maintenanceNoticeText({...never,lastRun:failedRun},now),{title:'Die tägliche Bereinigung ist noch nicht gelaufen.',text:`Die tägliche Bereinigung ist auf dieser Installation noch nie fertig geworden. Bis sie läuft, ${consequence}${failedText}`},'(a) never, last run failed');
check(maintenanceNoticeText(overdue,now),{title:'Die tägliche Bereinigung ist überfällig.',text:`Die tägliche Bereinigung ist zuletzt vor 3 Tagen fertig geworden. Bis sie wieder läuft, ${consequence} Öffne Einstellungen → Datenaufbewahrung, um den Status zu prüfen.`},'(b) overdue');
check(maintenanceNoticeText({...overdue,lastRun:failedRun},now),{title:'Die tägliche Bereinigung ist überfällig.',text:`Die tägliche Bereinigung ist zuletzt vor 3 Tagen fertig geworden. Bis sie wieder läuft, ${consequence}${failedText}`},'(b) overdue, last run failed');
check(maintenanceNoticeText({...never,lastRun:{startedAt:now-1000,finishedAt:null,status:'running'}},now).text.includes('fehlgeschlagen'),false,'a running last run adds nothing');

// 2. The component: nothing without a stale state, otherwise a warning with the link to the maintenance page.
check(MaintenanceNotice({status:undefined,now}),null,'no maintenance key (non-Owner)');
check(MaintenanceNotice({status:{...overdue,stale:false},now}),null,'not stale');
check(MaintenanceNotice({status:never,now:0}),null,'the clock does not run yet');
const text=node=>typeof node==='string'?node:!node||typeof node!=='object'?'':[node.props?.children].flat(Infinity).map(text).join('');
for(const status of [never,{...overdue,lastRun:failedRun}]){
 const tree=MaintenanceNotice({status,now}),{title,text:body}=maintenanceNoticeText(status,now);
 check([tree.type,tree.props.tone,tree.props.icon],[kit.Notice,'warning','Wrench'],'a Notice with tone warning and the Wrench icon');
 const children=[tree.props.children].flat();
 check(children[0].type,'strong','the title is bold');
 check(text(children[0]),title);
 check(text(tree),`${title} ${body}`,'the full sentence');
 const link=tree.props.action;
 check([link.type,link.props.href,link.props.target,link.props.rel],['a','#settings/retention',undefined,undefined],'the link opens the maintenance page in the same tab');
 check(link.props.className,'sdx-btn sdx-btn-ghost sdx-btn-sm','styled like Btn size="sm" variant="ghost"');
 const parts=[link.props.children].flat();
 check(parts.map(part=>part.type),['span'],'no external link icon');
 check(text(parts[0]),'Datenaufbewahrung öffnen');
 check(Object.keys(tree.props).sort(),['action','children','icon','tone'],'no dismiss handler: it cannot be closed');
}
check([notice.maintenanceDocsUrl,notice.maintenancePageHash],[undefined,'#settings/retention'],'no docs URL; the page hash');
check(/docs-base|ExternalLink|target=/.test(fs.readFileSync('ui/shell/maintenance-notice.tsx','utf8')),false,'the docs link and the external-link icon are gone');
const docs=fs.readFileSync('docs/self-hosting.md','utf8');
check(/^## Maintenance$/m.test(docs),true,'the anchor #maintenance exists');

// 3. The console renders it after the error notice, outside demo mode, in every view (demo mode is the top-bar pill, no notice).
const consoleSource=fs.readFileSync('ui/shell/console.tsx','utf8');
const main=consoleSource.slice(consoleSource.indexOf('<main id="console-content"'),consoleSource.indexOf('</main>'));
const demoNotice=main.indexOf('{demo&&<Notice tone="info"'),errorNotice=main.indexOf('{error&&<Notice tone="danger"'),maintenance=main.indexOf('{!demo&&<MaintenanceNotice status={data?.maintenance}/>}');
check([demoNotice,errorNotice>=0,maintenance>errorNotice],[-1,true,true],'no demo notice; the error notice, then the maintenance notice');
check(main.slice(errorNotice,maintenance).includes("view==="),false,'not bound to a view');
check((consoleSource.match(/<MaintenanceNotice /g)??[]).length,1,'rendered once');
console.log(`PASS ${checks} maintenance notice checks: texts (a)/(b) with and without failed last run, null unless stale, warning with the page link, position in the console.`);
