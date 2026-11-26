// The kit NameConfirmDrawer (ui/kit/name-confirm-drawer.tsx), the typed-name confirmation of an irreversible delete:
// the danger button stays blocked with its reason until the trimmed input equals the name, Enter in the field confirms
// only while it matches and no request runs, the close clears the typed name, a new opening starts empty, and the
// consequences come before the field. Then GroupDeleteDrawer (ui/devices/fleet/groups.tsx) on it renders the same markup
// as its own drawer before the extraction, and useDrawerClose hands over to a next step after the close. Runs on the
// hook cells of tests/support/panel-harness.mjs with the real kit; no server or browser is touched.
import assert from 'node:assert/strict';
import React from 'react';
import {Trash2} from 'lucide-react';
import {renderToStaticMarkup} from 'react-dom/server';
import {panelHarness} from '../../support/panel-harness.mjs';
import {de} from '../../support/i18n-stubs.mjs';

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const harness=panelHarness({hooked:['ui/kit/name-confirm-drawer.tsx'],stubs:{'@/ui/base/api':{api:async()=>({}),message:String,downloadText(){}},'@/ui/session/mfa-step-up':{MfaStepUp:()=>null}}});
const {NameConfirmDrawer,nameConfirmed}=harness.load('ui/kit/name-confirm-drawer.tsx'),kit=harness.load('ui/kit/kit.tsx');

// 1. The rule.
check([nameConfirmed('Kunde B','Kunde B'),nameConfirmed('  Kunde B ','Kunde B'),nameConfirmed('kunde b','Kunde B'),nameConfirmed('Kunde','Kunde B'),nameConfirmed('Kunde B',null)],[true,true,false,false,false],'equal after trimming, case counts, nothing without a name');

// 2. The drawer.
{
 const events=[];
 let props={open:true,name:'Kunde B',title:'Kunde B löschen?',description:'Endgültig.',icon:kit.IconTile,iconTone:'danger',fieldLabel:'Name eingeben',confirmLabel:'Kunde löschen',enterNameFirst:'Gib zuerst den Namen ein.',busy:false,
  onClose:()=>events.push('close'),onConfirm:()=>events.push('confirm'),children:React.createElement('p',null,'Folgen')};
 let drawer=harness.tree(NameConfirmDrawer,props);
 const render=(patch={})=>{props={...props,...patch};drawer=harness.tree(NameConfirmDrawer,props);return drawer;};
 const footer=()=>[drawer.props.footer.props.children].flat();
 const confirm=()=>footer()[1];
 const input=()=>harness.walk(drawer.props.children).find(node=>node.type==='input');
 check([drawer.type,drawer.props.title,drawer.props.description,drawer.props.iconTone],[kit.Drawer,'Kunde B löschen?','Endgültig.','danger'],'the kit Drawer with title, description and tone');
 check(footer().map(node=>node.type),[kit.DrawerCancel,kit.Btn],'DrawerCancel, then the confirm Btn');
 check([confirm().props.variant,confirm().props.icon.displayName,confirm().props.blocked,confirm().props.loading],['danger','Trash2','Gib zuerst den Namen ein.',false],'the danger Trash2 button, blocked with its reason');
 const body=[drawer.props.children].flat();
 check([body[0].props.className,harness.text(body[0].props.children[0])],['sdx-form-grid','Folgen'],'the consequences come first, in the form grid');
 check([input().props.autoFocus,input().props.placeholder,input().props.value],[true,'Kunde B',''],'the field: autofocus, the name as placeholder, empty');
 // Enter does nothing while the name does not match.
 input().props.onKeyDown({key:'Enter'});
 input().props.onChange({target:{value:'Kunde'}});render();
 input().props.onKeyDown({key:'Enter'});
 check([events,confirm().props.blocked],[[],'Gib zuerst den Namen ein.'],'a partial name: still blocked, Enter confirms nothing');
 input().props.onChange({target:{value:'  Kunde B  '}});render();
 check(confirm().props.blocked,undefined,'the trimmed name unblocks the button');
 input().props.onKeyDown({key:'a'});input().props.onKeyDown({key:'Enter'});
 check(events,['confirm'],'Enter confirms while it matches');
 render({busy:true});
 input().props.onKeyDown({key:'Enter'});
 check([events,confirm().props.loading,input().props.disabled],[['confirm'],true,true],'while busy: loading, the field is disabled and Enter waits');
 render({busy:false});
 // The drawer close tells the caller and clears the field; the next opening starts empty too.
 drawer.props.onClose();render();
 check([events.at(-1),input().props.value],['close',''],'the close clears the typed name');
 // A set during render (the opening) shows in the next render, as React renders again at once.
 input().props.onChange({target:{value:'Kunde B'}});render({open:false});render({open:true});render();
 check(input().props.value,'','a new opening starts with an empty field');
 render({name:null});
 check(input(),undefined,'no name: no field');
}

// 3. GroupDeleteDrawer on the kit drawer renders what its own drawer rendered before.
{
 const {GroupDeleteDrawer}=harness.load('ui/devices/fleet/groups.tsx');
 const t=(key,params)=>de(key,params);
 // The component as it was before it moved onto the kit drawer, on the same kit parts.
 function OldGroupDeleteDrawer({group,busy,onClose,onDelete}){
  const [typed,setTyped]=React.useState('');
  const matches=!!group&&typed.trim()===group.name;
  return React.createElement(kit.Drawer,{open:!!group,onClose:()=>{setTyped('');onClose();},title:t('tree.deleteGroup'),description:group?t('groups.delete.description',{name:group.name}):undefined,
   footer:React.createElement(React.Fragment,null,React.createElement(kit.DrawerCancel),React.createElement(kit.Btn,{variant:'danger',icon:Trash2,loading:busy,blocked:matches?undefined:t('groups.delete.enterNameFirst'),onClick:onDelete},t('groups.delete.confirm')))},
   group&&React.createElement('label',{className:'sdx-field'},React.createElement('span',null,t('groups.delete.typeName')),React.createElement('input',{autoFocus:true,value:typed,placeholder:group.name,disabled:busy,onChange:event=>setTyped(event.target.value),onKeyDown:()=>{}})));
 }
 const group={id:'g-1',name:'Hamburg',description:'',parentId:null,depth:0,deviceCount:0,permissions:[]};
 for(const busy of [false,true]){
  const now=renderToStaticMarkup(React.createElement(GroupDeleteDrawer,{group,busy,onClose(){},onDelete(){}}));
  const before=renderToStaticMarkup(React.createElement(OldGroupDeleteDrawer,{group,busy,onClose(){},onDelete(){}}));
  check(now,before,`busy ${busy}: the same markup as before the extraction`);
  check(now.includes('Hamburg'),true,'it names the group');
 }
 check(renderToStaticMarkup(React.createElement(GroupDeleteDrawer,{group:null,busy:false,onClose(){},onDelete(){}})),'','closed: nothing renders');
}

// 4. useDrawerClose: a close that hands over to a next step runs it after the drawer closed.
{
 const order=[];let close=null;
 function Capture(){close=kit.useDrawerClose();return null;}
 renderToStaticMarkup(React.createElement(kit.Drawer,{open:true,title:'Test',onClose:()=>order.push('closed')},React.createElement(Capture)));
 check(typeof close,'function','the guarded close of the surrounding drawer');
 close(()=>order.push('next'));
 check(order,['closed','next'],'a clean drawer closes first, then the next step runs');
 let outside='unset';function Outside(){outside=kit.useDrawerClose();return null;}
 renderToStaticMarkup(React.createElement(Outside));
 check(outside,null,'null outside a Drawer');
}

console.log(`${checks} name confirm drawer checks passed.`);
