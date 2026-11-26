// The Owner notice "Old session secret still set" with the real
// ui/shell/previous-secret-notice.tsx and kit.tsx, in English and German
// (harness as in tests/ui/shell/maintenance-notice-view.mjs). No server or browser is touched.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {i18nStubs,i18nRequire,localeHooks,translateModule} from '../../support/i18n-stubs.mjs';

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
const kit=load('ui/kit/kit.tsx',{...i18nStubs,react:{forwardRef:render=>render,createContext:()=>({Provider:'Provider'})},'radix-ui':{Dialog:{},DropdownMenu:{}},recharts:{},'@/ui/kit/tooltip':{Tooltip:({children})=>children},'@/ui/kit/chart':load('ui/kit/chart.ts'),'@/ui/kit/focus-return':load('ui/kit/focus-return.ts'),'@/ui/kit/confirm-dialog':{ConfirmDialog:'ConfirmDialog'},'@/ui/kit/overflow-focusable':{useScrollEdges:()=>({start:false,end:false}),useOverflowFocusable:()=>[{current:null},false]}});
const docsBase=load('ui/base/docs-base.ts');
const notice=locale=>load('ui/shell/previous-secret-notice.tsx',{'@/ui/base/docs-base':docsBase,'@/ui/kit/kit':kit,'@/ui/base/locale':{...localeHooks,useT:()=>(key,params)=>translateModule.translate(locale,key,params)}});
const text=node=>typeof node==='string'?node:!node||typeof node!=='object'?'':[node.props?.children].flat(Infinity).map(text).join('');

const copy={
 en:{title:'The old session secret is still set.',text:'Every stored secret now uses the current SESSION_SECRET. Remove SESSION_SECRET_PREVIOUS from the configuration and restart the portal.',guide:'Guide'},
 de:{title:'Das alte Session-Secret ist noch gesetzt.',text:'Alle gespeicherten Geheimnisse verwenden jetzt das aktuelle SESSION_SECRET. Entferne SESSION_SECRET_PREVIOUS aus der Konfiguration und starte das Portal neu.',guide:'Anleitung'},
};
for(const [locale,expected] of Object.entries(copy)){
 const PreviousSecretNotice=notice(locale).default;
 // 1. Nothing without the flag (non-Owner, not removable).
 for(const removable of [undefined,false])check(PreviousSecretNotice({removable}),null,`${locale}: no notice for ${removable}`);
 // 2. A warning with the exact copy and the guide link.
 const tree=PreviousSecretNotice({removable:true});
 check([tree.type,tree.props.tone,tree.props.icon],[kit.Notice,'warning','KeyRound'],`${locale}: a Notice with tone warning and the KeyRound icon`);
 const children=[tree.props.children].flat();
 check([children[0].type,text(children[0])],['strong',expected.title],`${locale}: the bold title`);
 check(text(tree),`${expected.title} ${expected.text}`,`${locale}: the full sentence`);
 check(/\d|k1\./.test(text(tree)),false,`${locale}: no count, kid or ciphertext`);
 const link=tree.props.action;
 check([link.type,link.props.href,link.props.target,link.props.rel],['a','https://github.com/LostInDreamZ/nodiverna/blob/main/ServerDesk/docs/self-hosting.md#change-the-session-secret','_blank','noreferrer'],`${locale}: the guide link`);
 check(link.props.className,'sdx-btn sdx-btn-ghost sdx-btn-sm','styled like Btn size="sm" variant="ghost"');
 const [icon,label]=[link.props.children].flat();
 check([icon.type,icon.props.size,icon.props['aria-hidden']],['ExternalLink',13,true],'the external link icon');
 check(text(label),expected.guide,`${locale}: the guide label reuses maintenance.guide`);
 check(Object.keys(tree.props).sort(),['action','children','icon','tone'],'no dismiss handler: it cannot be closed');
}
const docs=fs.readFileSync('docs/self-hosting.md','utf8');
check(/^## Change the session secret$/m.test(docs),true,'the anchor #change-the-session-secret exists');

// 3. The console renders it right after the maintenance notice, outside demo mode, in every view.
const consoleSource=fs.readFileSync('ui/shell/console.tsx','utf8');
const main=consoleSource.slice(consoleSource.indexOf('<main id="console-content"'),consoleSource.indexOf('</main>'));
const maintenance=main.indexOf('{!demo&&<MaintenanceNotice status={data?.maintenance}/>}'),previous=main.indexOf('{!demo&&<PreviousSecretNotice removable={data?.previousSecretRemovable}/>}');
check([maintenance>=0,previous>maintenance],[true,true],'next to the maintenance notice, hidden in demo mode');
check(main.slice(maintenance,previous).includes('view==='),false,'not bound to a view');
check((consoleSource.match(/<PreviousSecretNotice /g)??[]).length,1,'rendered once');
console.log(`PASS ${checks} previous-secret notice checks: null without the flag, exact EN and DE copy, warning with KeyRound and guide link, position in the console.`);
