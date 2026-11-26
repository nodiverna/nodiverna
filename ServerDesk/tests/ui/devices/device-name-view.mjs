// The device rename in the console, without a server or browser:
// - the rename drawer (ui/devices/device/device-name.tsx) with minimal hooks: the
//   preselected choice, the custom name field, the field error after the first
//   submit, the request, the success and failure feedback and the previous names;
// - the console (ui/shell/console.tsx) through tests/support/console-harness.mjs:
//   the palette device items carry the previous names as keywords, the palette
//   has "Rename device" for the open device, and DeviceView opens the drawer.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {de,i18nRequire} from '../../support/i18n-stubs.mjs';
import {consoleHarness} from '../../support/console-harness.mjs';

const deviceName=await import('../../../lib/device-name.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};

// ---- The drawer ----
const jsx=(type,props,key)=>({type,props:props??{},key});
const source=filename=>ts.transpileModule(fs.readFileSync(path.resolve(filename),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
const load=(filename,require)=>{const mod={exports:{}};new Function('require','module','exports',source(filename))(require,mod,mod.exports);return mod.exports;};
const tree=node=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(tree):[node,...Object.values(node.props??{}).flatMap(value=>typeof value==='object'?tree(value):[])];

function drawer(server,{reply=()=>Promise.resolve({ok:true}),demo=false,viewer={id:'owner',label:'owner',permissions:['*']}}={}){
 const cells=[],posts=[],toasts=[],events=[];let cursor=0,dirty=false,root;
 const hooks={useId:()=>'name-form',useState(initial){const index=cursor++;cells[index]??={value:typeof initial==='function'?initial():initial};return [cells[index].value,value=>{const next=typeof value==='function'?value(cells[index].value):value;if(!Object.is(next,cells[index].value)){cells[index].value=next;dirty=true;}}];}};
 const shared={api:async(url,body)=>{posts.push({url,body});return reply(url,body);},message:failure=>failure.message,permitted:(device,_viewer,right)=>(device.permissions??['*']).includes('*')||(device.permissions??[]).includes(right)};
 const require=id=>i18nRequire(id)??(id==='react'?hooks:id==='react/jsx-runtime'?{jsx,jsxs:jsx,Fragment:'Fragment'}:id==='lucide-react'?new Proxy({},{get:(_target,key)=>String(key)})
  :id==='sonner'?{toast:{success:message=>toasts.push(message),error:message=>toasts.push('error:'+message)}}:id==='@/lib/device-name'?deviceName:id==='@/ui/base/api'?shared
  :id==='@/ui/kit/kit'?{Btn:'Btn',Drawer:'Drawer',Facts:'Facts',PickRow:'PickRow'}:id==='@/ui/kit/field'?{Field:'Field'}:(()=>{throw Error('Unexpected import '+id);})());
 const {DeviceNameDrawer}=load('ui/devices/device/device-name.tsx',require);
 const props={open:true,server,viewer,demo,onClose:()=>events.push('close'),onRefresh:()=>{events.push('refresh');}};
 const render=()=>{let limit=0;do{dirty=false;cursor=0;root=DeviceNameDrawer(props);if(limit++>12)throw Error('Unstable render');}while(dirty);};
 render();
 const all=()=>tree(root);
 const find=predicate=>all().find(predicate);
 return {posts,toasts,events,render,
  get root(){return root;},
  rows:()=>all().filter(node=>node.type==='PickRow'),
  field:()=>find(node=>node.type==='Field'),
  input:()=>find(node=>node.type==='input'),
  submit:()=>root.props.footer.props.children.find(node=>node.type==='Btn'&&node.props.type==='submit'),
  facts:()=>find(node=>node.type==='Facts'),
  pick(label){find(node=>node.type==='PickRow'&&node.props.label===label).props.onSelect();render();},
  type(value){find(node=>node.type==='input').props.onChange({target:{value}});render();},
  // The form calls the async submit without returning it; let it finish.
  async send(){find(node=>node.type==='form').props.onSubmit({preventDefault(){}});for(let round=0;round<5;round++)await new Promise(resolve=>setImmediate(resolve));render();},
 };
}

const useHostname=de('device.name.useHostname'),useCustom=de('device.name.useCustom');
const server=(changes={})=>({id:'11111111-1111-4111-8111-111111111111',name:'SRV-APP01',createdAt:0,lastSeen:0,revoked:0,management:1,snapshot:{hostname:'SRV-APP01'},nameSource:'hostname',previousNames:[],...changes});
{
 const ui=drawer(server());
 check([ui.root.type,ui.root.props.open,ui.root.props.icon,ui.root.props.title,ui.root.props.description],['Drawer',true,'PencilLine',de('device.name.title'),de('device.name.intro')],'a Drawer with the icon tile, title and intro');
 check(ui.rows().map(row=>[row.props.label,row.props.selected]),[[useHostname,true],[useCustom,false]],'the stored source is preselected');
 check(ui.rows()[0].props.hint,de('device.name.useHostnameHint',{hostname:'SRV-APP01'}),'the hint names the reported computer name');
 check(find(ui,'radiogroup'),true,'the rows sit in a radiogroup');
 check([ui.field(),ui.facts()],[undefined,undefined],'no name field and no previous names');
 check([ui.submit().props.form,ui.submit().props.blocked],['name-form',de('common.noChanges')],'the submit is blocked with "No changes"');
 ui.pick(useCustom);
 check([ui.field().props.label,ui.input().props.maxLength,ui.input().props.autoFocus,ui.input().props.value],[de('device.name.field'),64,true,'SRV-APP01'],'the custom choice shows the field, max 64, focused, with the current name');
 check([ui.field().props.hint,ui.field().props.error],[de('device.name.fieldHint'),undefined],'the rule as hint, no error yet');
 ui.type('Bad<name>');
 check(ui.field().props.error,undefined,'no field error before the first submit');
 await ui.send();
 check([ui.field().props.error,ui.posts],[de('device.name.fieldError'),[]],'an invalid name shows the field error after the submit and sends nothing');
 ui.type('  Fileserver Berlin ');
 check(ui.field().props.error,undefined,'a valid name clears the error');
 await ui.send();
 check(ui.posts,[{url:'/api/device-name',body:{serverId:'11111111-1111-4111-8111-111111111111',source:'custom',name:'Fileserver Berlin',expected:'SRV-APP01'}}],'the request names the source, the trimmed name and the shown name');
 check([ui.toasts,ui.events],[[de('device.name.renamed')],['refresh','close']],'success: toast, refresh, close');
}
{
 // A failure keeps the drawer open and the draft.
 const failed=Object.assign(new Error(de('apiError.deviceName.changed')),{code:'DEVICE_NAME_CHANGED'});
 const ui=drawer(server({nameSource:'custom',name:'Fileserver Berlin',previousNames:['SRV-OLD','SRV-OLDER']}),{reply:()=>Promise.reject(failed)});
 check(ui.rows().map(row=>row.props.selected),[false,true],'a custom name preselects "Use a custom name"');
 check(ui.facts().props.items.map(item=>[item.label,item.value]),[[de('device.name.previous'),'SRV-OLD, SRV-OLDER']],'the previous names are listed');
 ui.pick(useHostname);
 check(ui.field(),undefined,'the computer name hides the field');
 check(ui.submit().props.blocked,undefined,'another choice can be sent');
 await ui.send();
 check(ui.posts.map(post=>post.body),[{serverId:'11111111-1111-4111-8111-111111111111',source:'hostname',expected:'Fileserver Berlin'}],'the switch sends no name');
 check([ui.toasts,ui.events],[['error:'+de('apiError.deviceName.changed')],[]],'failure: an error toast, the drawer stays open');
 ui.pick(useCustom);ui.type('Mine');await ui.send();
 check([ui.input().props.value,ui.events],['Mine',[]],'after a failure the draft stays');
}
{
 // Pending, no report, demo and missing right.
 const pending=drawer(server({nameSource:'pending',name:'srv-app01'}));
 check(pending.rows().map(row=>row.props.selected),[true,false],'pending with the reported name preselects the computer name');
 const quiet=drawer(server({snapshot:null,nameSource:'pending',name:'Office'}));
 check([quiet.rows().map(row=>row.props.selected),quiet.rows()[0].props.hint],[[false,true],de('device.name.noHostnameHint')],'without a report: custom preselected and the "not reported" hint');
 const demo=drawer(server(),{demo:true});demo.pick(useCustom);demo.type('Other');
 check(demo.submit().props.blocked,de('kit.unavailable.demo'),'sample devices block the submit');
 await demo.send();check(demo.posts,[],'and send nothing');
 const reader=drawer(server({permissions:['view']}));reader.pick(useCustom);reader.type('Other');
 check(reader.submit().props.blocked,de('device.metadata.noRight'),'without groups.manage the submit is blocked');
}
function find(ui,role){return tree(ui.root).some(node=>node.props?.role===role);}

// ---- The console ----
const now=Date.now();
const device=(id,name,changes={})=>({id,name,createdAt:now-3600000,lastSeen:now-30000,revoked:0,management:1,snapshot:null,permissions:['view','groups.manage'],groupId:null,groupName:null,groups:[],nameSource:'hostname',previousNames:[],...changes});
const servers=[device('srv-1','SRV-NEW',{previousNames:['SRV-OLD','SRV-OLDER']}),device('srv-2','SRV-TWO'),device('srv-3','SRV-GONE',{revoked:1})];
const owner={id:'owner',label:'owner@example.test',permissions:['*']};
const harness=hash=>consoleHarness({viewer:owner,hash,base:{servers,jobs:[],deviceGroups:[],permissionDevices:[],customers:[],audit:[],deviceAudit:[],maintenance:null}});
const items=ui=>ui.find('CommandPalette').props.getItems();
{
 const ui=harness('#devices');await ui.settle();
 const renamed=items(ui).find(item=>item.id==='device-srv-1');
 check(renamed.label,'SRV-NEW','the palette device item shows the current name');
 check(['SRV-OLD','SRV-OLDER'].map(name=>renamed.keywords.includes(name)),[true,true],'its keywords carry the previous names');
 check(items(ui).some(item=>item.id==='device-rename'),false,'outside the device view there is no rename action');
 check(ui.find('DeviceNameDrawer'),undefined,'no drawer before an opening');
}
{
 const ui=harness('#devices/srv-1');await ui.settle();
 const rename=items(ui).find(item=>item.id==='device-rename');
 check([rename.group,rename.label,rename.Icon],['SRV-NEW',de('device.name.rename'),'PencilLine'],'the open device has "Rename device", grouped under its name');
 rename.run();ui.render();await ui.settle();
 const opened=ui.find('DeviceNameDrawer');
 check([opened.props.open,opened.props.server.id],[true,'srv-1'],'the palette action opens the drawer for the open device');
 opened.props.onClose();ui.render();await ui.settle();
 check([ui.find('DeviceNameDrawer').props.open,ui.find('DeviceNameDrawer').key],[false,opened.key],'closing keeps the drawer mounted, so it slides out');
 ui.device().props.onRename();ui.render();await ui.settle();
 check([ui.find('DeviceNameDrawer').props.open,ui.find('DeviceNameDrawer').key===opened.key],[true,false],'the header entry opens a fresh drawer');
 await ui.find('DeviceNameDrawer').props.onRefresh();
 check(ui.refreshes.length>0,true,'a rename refreshes the console data');
}
{
 const ui=harness('#devices/srv-3');await ui.settle();
 check(items(ui).some(item=>item.id==='device-rename'),false,'a removed device has no rename action');
}
console.log(`PASS device name view (${checks} checks): drawer choice, field, error after submit, request, success and failure feedback, previous names, blocked reasons; palette keywords and rename action, drawer opening from palette and header.`);
