// The edit mode of the Dashboard (ui/devices/dashboard/dashboard-view.tsx, dashboard-edit.tsx, dashboard-catalog-drawer.tsx,
// use-dashboard-layout.ts, use-alarm-week.ts; docs/dashboard.md), driven through its handlers: Customize turns it on
// with the header actions (Add widget…, More actions, Cancel, Save), the notice, inert widget content and the edit
// controls of each widget; the arrow keys and the menu move and resize a widget, say the result in the status region
// and say why a step at a limit cannot be taken; Remove takes a widget off the draft; the catalog lists the widgets
// the viewer can use in groups, searches them, adds and removes; Save sends the draft and keeps the answer, with the
// toast; "Reset to default" stores no layout; a failed save keeps the edit mode and the draft; Cancel leaves, and
// asks first when the draft changed; the Owner edits the default layout; sample devices cannot edit; the palette
// request turns the edit mode on; and the alarm week loads once, again on a refresh, and only while one of its two
// widgets is on the board.
import assert from 'node:assert/strict';
import {panelHarness} from '../../support/panel-harness.mjs';

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};
const hooks=['ui/kit/use-flip.ts','ui/shell/page-frame.ts','ui/devices/dashboard/use-dashboard-layout.ts','ui/devices/dashboard/use-alarm-week.ts','ui/devices/dashboard/use-dashboard-drag.ts','ui/devices/dashboard/use-grid-columns.ts'];
const page=panelHarness({hooked:['ui/devices/dashboard/dashboard-view.tsx',...hooks],locale:'en'});
const catalogHarness=panelHarness({hooked:['ui/devices/dashboard/dashboard-catalog-drawer.tsx'],locale:'en'});
const DashboardView=page.load('ui/devices/dashboard/dashboard-view.tsx').default;
const {WidgetEditControls,WidgetResizeHandle,moveKeyTarget,resizeKeyDirection,moveHandleId,resizeHandleId}=page.load('ui/devices/dashboard/dashboard-edit.tsx');
const {DashboardCatalogDrawer:PageCatalog}=page.load('ui/devices/dashboard/dashboard-catalog-drawer.tsx');
const {AlarmWeekWidget,AlarmTrendWidget}=page.load('ui/devices/dashboard/dashboard-widgets.tsx');
const {DashboardCatalogDrawer}=catalogHarness.load('ui/devices/dashboard/dashboard-catalog-drawer.tsx');
const {builtInDashboardLayout,dashboardWidgetIds}=page.load('lib/dashboard-layout.ts');

const now=Date.now();
const device=(name,extra={})=>({id:name.toLowerCase(),name,createdAt:0,lastSeen:now-30_000,revoked:0,management:1,snapshot:null,...extra});
const short=layout=>layout.map(item=>`${item.id}:${item.w}x${item.h}`);
const builtIn=short(builtInDashboardLayout);
const key=name=>({key:name,prevented:false,preventDefault(){this.prevented=true;}});

// One page: its props, the recorded calls, and helpers that read the element tree.
function start(overrides={}){
 page.reset();catalogHarness.reset();
 const saves=[],kept=[],loads=[];
 const state={props:{
  header:(actions,primary)=>({type:'header',props:{children:[actions,primary]}}),servers:[device('A'),device('B')],jobs:[],viewer:{id:'u1',label:'Anna',permissions:['*']},demo:false,saving:false,narrow:false,owner:false,
  preference:{own:null,default:builtInDashboardLayout},refreshKey:0,customizeRequest:0,onNavigate(){},onAddDevice(){},onSelectJob(){},onCancelJob(){},
  onPreference:next=>{kept.push(next);state.props.preference=next;},
  saveLayout:async(mode,layout)=>{saves.push([mode,layout&&short(layout)]);if(state.fail)throw new Error(state.fail);return mode==='own'?{own:layout,default:state.props.preference.default}:{own:state.props.preference.own,default:layout??builtInDashboardLayout};},
  loadWeek:async()=>{loads.push(1);return {start:0,hours:[]};},
  ...overrides}};
 const tree=()=>page.tree(DashboardView,state.props);
 const cells=()=>page.walk(tree()).filter(node=>node.props['data-widget']);
 const api={state,saves,kept,loads,tree,cells,
  /** The widgets the page shows, each with its shown size. */
  shown:()=>cells().map(cell=>`${cell.props['data-widget']}:${cell.props['data-w']}x${cell.props['data-h']}`),
  board:()=>page.find(tree(),node=>node.props.className==='sdx-dash-board').props,
  header:()=>page.find(tree(),node=>node.type==='header'),
  button:label=>page.button(api.header(),label),
  customize:()=>api.button('Customize').props.onClick(),
  /** The props of the edit controls of a widget (the page builds them), and their own element tree. */
  controls:id=>page.walk(tree()).find(node=>node.type===WidgetEditControls&&node.props.widget.id===id)?.props,
  controlsView:id=>page.tree(WidgetEditControls,api.controls(id)),
  handle:id=>page.walk(tree()).find(node=>node.type===WidgetResizeHandle&&node.props.widget.id===id)?.props,
  handleView:id=>page.tree(WidgetResizeHandle,api.handle(id)),
  menu:id=>page.menu(api.controlsView(id),`Actions for ${api.controls(id).name}`),
  entry:(id,label)=>api.menu(id).find(item=>item.label===label),
  said:()=>page.walk(tree()).find(node=>node.props.role==='status'&&node.props.className==='sr-only').props.children,
  catalog:()=>page.find(tree(),node=>node.type===PageCatalog)?.props,
  catalogView:()=>catalogHarness.tree(DashboardCatalogDrawer,api.catalog()),
  catalogRows:()=>catalogHarness.walk(api.catalogView()).filter(node=>node.props.className==='sdx-dash-catalog-row').map(row=>[catalogHarness.walk(row).find(node=>node.type==='strong').props.children,row.props['data-added'],catalogHarness.walk(row).find(node=>node.props.onClick).props['aria-label']]),
  confirm:()=>page.walk(tree()).find(node=>node.props.confirmLabel!==undefined).props,
  save:async()=>{api.button('Save').props.onClick();await page.settle();},
  note:()=>{const note=page.find(tree(),node=>node.props.className==='sdx-dash-edit-note');return note?page.text(note):null;},
 };
 return api;
}

// ---- outside the edit mode ----
let ui=start();
check([ui.shown(),ui.board()['data-editing'],ui.board()['data-columns'],ui.note(),ui.catalog()],[builtIn,undefined,4,null,undefined],'the page shows the default layout on four columns; no edit mode, no notice, no catalog');
check([!!ui.button('Customize'),!!ui.button('Save'),!!ui.button('Cancel'),ui.controls('alarms'),ui.handle('alarms'),ui.cells()[0].props.onPointerDown],[true,false,false,undefined,undefined,undefined],'the header has Customize alone; a widget has no edit control and takes no drag');
ok(page.walk(ui.tree()).filter(node=>node.props.size&&node.props.onNavigate).every(node=>node.props.edit===undefined),'no widget is in edit mode');

// ---- Customize turns the edit mode on ----
ui.customize();
check([ui.board()['data-editing'],ui.shown(),!!ui.button('Customize')],[true,builtIn,false],'the board is in edit mode with the same layout; Customize is gone');
check([ui.button('Add widget…').props.id,ui.button('Cancel').props.variant,ui.button('Save').props.variant,ui.button('Save').props.blocked,page.menu(ui.header(),'More actions').map(entry=>[entry.label,entry.blocked])],
 ['dashboard-add-widget','ghost','secondary','No changes.',[['Reset to default','You already use the default layout.']]],'the header: Add widget…, More actions with a blocked reset, Cancel, and Save blocked while nothing changed');
check(ui.note(),'You are editing your dashboard. Only your account sees the changes.   Drag a widget by its handle to move it, or drag its corner to resize it. The arrow keys and the menu of each widget do the same.','the notice says what is edited and how');
const first=ui.controls('alarms');
check([first.name,first.index,first.total,first.columns,first.widget],['Open alarms',0,12,4,{id:'alarms',w:2,h:2}],'each widget gets its edit controls: its name, its place, the columns');
ok(page.walk(ui.tree()).filter(node=>node.props.size&&node.props.onNavigate).every(node=>node.props.edit?.type===WidgetEditControls),'every widget takes its edit controls (they replace the head action and make the content inert)');
check([typeof ui.cells()[0].props.onPointerDown,typeof first.onMoveStart,typeof ui.handle('alarms').onResizeStart],['function','function','function'],'the cell, the move handle and the resize handle take a pointer drag');
let view=ui.controlsView('alarms');
const grip=()=>page.labelled(ui.controlsView('alarms'),'Move Open alarms').props;
check([grip().id,grip().className,grip()['aria-keyshortcuts'],page.labelled(view,'Remove Open alarms').props.label,page.labelled(view,'Actions for Open alarms').props.label],[moveHandleId('alarms'),'sdx-dash-grip','ArrowLeft ArrowRight Home End','Remove Open alarms','Actions for Open alarms'],'the head controls name the widget: move handle, menu, Remove');
view=ui.handleView('alarms');
check([page.labelled(view,'Resize Open alarms').props.id,page.labelled(view,'Resize Open alarms').props.className,page.find(view,node=>node.props.className==='sdx-dash-size').props.children,page.find(view,node=>node.props.className==='sdx-dash-size').props['aria-hidden']],[resizeHandleId('alarms'),'sdx-dash-resize','2 × 2','true'],'the resize handle names the widget, and the widget shows its size');

// ---- move: the arrow keys on the handle, and the menu ----
check([moveKeyTarget('ArrowRight',0,3),moveKeyTarget('ArrowDown',2,3),moveKeyTarget('ArrowLeft',0,3),moveKeyTarget('ArrowUp',2,3),moveKeyTarget('Home',2,3),moveKeyTarget('End',0,3),moveKeyTarget('Enter',1,3),moveKeyTarget('a',1,3)],[1,2,0,1,0,2,null,null],'the place a key asks for: one earlier or later inside the list, first, last; no other key');
let pressed=key('ArrowRight');grip().onKeyDown(pressed);
check([pressed.prevented,ui.shown().slice(0,3),ui.said(),ui.controls('alarms').index],[true,['offline:1x2','alarms:2x2','updates:1x2'],'Open alarms is now widget 2 of 12.',1],'Arrow Right moves the widget one place later; the status region says its new place');
check([ui.button('Save').props.variant,ui.button('Save').props.blocked,page.menu(ui.header(),'More actions')[0].blocked],['primary',undefined,undefined],'Save is the primary while the draft differs; the reset is free');
grip().onKeyDown(key('End'));
check([ui.shown().at(-1),ui.said()],['alarms:2x2','Open alarms is now widget 12 of 12.'],'End moves it to the last place');
pressed=key('ArrowDown');grip().onKeyDown(pressed);
check([pressed.prevented,ui.shown().at(-1),ui.said()],[true,'alarms:2x2','Open alarms is now widget 12 of 12.'],'at the end Arrow Down changes nothing (the key is still taken)');
grip().onKeyDown(key('Home'));
check([ui.shown(),ui.said(),ui.button('Save').props.blocked],[builtIn,'Open alarms is now widget 1 of 12.','No changes.'],'Home moves it back to the first place; the draft equals the stored layout again');
pressed=key('Tab');grip().onKeyDown(pressed);
check(pressed.prevented,false,'another key stays the browser\'s');
check([ui.entry('alarms','Move earlier').blocked,ui.entry('alarms','Move later').blocked,ui.entry('crashes','Move later').blocked,ui.entry('crashes','Move earlier').blocked],['This widget is already first.',undefined,'This widget is already last.',undefined],'the menu: the first widget cannot move earlier and the last not later, each with its reason');
ui.entry('offline','Move earlier').onSelect();
check([ui.shown().slice(0,2),ui.said()],[['offline:1x2','alarms:2x2'],'Offline devices is now widget 1 of 12.'],'"Move earlier" of the menu does the same as the key');
ui.entry('offline','Move later').onSelect();
check(ui.shown(),builtIn,'and "Move later" puts it back');

// ---- resize: the arrow keys on the handle, and the menu ----
check(['ArrowRight','ArrowLeft','ArrowDown','ArrowUp','Home','x'].map(resizeKeyDirection),['wider','narrower','taller','shorter',null,null],'the step a key asks for');
const resizer=id=>page.labelled(ui.handleView(id),`Resize ${ui.handle(id).name}`).props;
pressed=key('ArrowRight');resizer('alarms').onKeyDown(pressed);
check([pressed.prevented,ui.shown()[0],ui.said()],[true,'alarms:3x2','Open alarms now has the size 3 × 2.'],'Arrow Right makes the widget wider; the status region says the new size');
resizer('alarms').onKeyDown(key('ArrowDown'));
check([ui.shown()[0],ui.said(),page.find(ui.handleView('alarms'),node=>node.props.className==='sdx-dash-size').props.children],['alarms:3x3','Open alarms now has the size 3 × 3.','3 × 3'],'Arrow Down makes it taller');
resizer('alarms').onKeyDown(key('ArrowDown'));
check([ui.shown()[0],ui.said()],['alarms:3x3','This widget cannot be taller.'],'a step at a limit changes nothing and says why');
resizer('alarms').onKeyDown(key('ArrowLeft'));resizer('alarms').onKeyDown(key('ArrowUp'));
check([ui.shown()[0],ui.button('Save').props.blocked],['alarms:2x2','No changes.'],'Arrow Left and Arrow Up bring the size back');
check(ui.menu('alarm-week').filter(item=>item.label).map(item=>[item.label,item.blocked??null,!!item.danger]),
 [['Move earlier',null,false],['Move later',null,false],['Wider',null,false],['Narrower','This widget cannot be narrower.',false],['Taller',null,false],['Shorter','This widget cannot be shorter.',false],['Remove',null,true]],'the menu of the heatmap at its smallest size: every step, blocked with its reason where it cannot be taken, and Remove last as the danger entry');
check(ui.menu('alarms').map(item=>item.heading??(item.separator?'-':item.label)),['Move earlier','Move later','-','Size','Wider','Narrower','Taller','Shorter','-','Remove'],'the entries in order, the size steps under their heading');
ui.entry('defender','Wider').onSelect();ui.entry('defender','Wider').onSelect();ui.entry('defender','Wider').onSelect();
check([ui.shown().find(item=>item.startsWith('defender:')),ui.entry('defender','Wider').blocked,ui.said()],['defender:4x1','This widget is already as wide as the dashboard.','Microsoft Defender now has the size 4 × 1.'],'"Wider" of the menu, up to the full width');
ui.entry('defender','Narrower').onSelect();ui.entry('defender','Narrower').onSelect();ui.entry('defender','Narrower').onSelect();
check(ui.shown(),builtIn,'and back');

// ---- remove ----
ui.controls('updates').onRemove();
check([ui.shown().some(item=>item.startsWith('updates:')),ui.shown().length,ui.said(),ui.controls('alarm-week').index],[false,11,'Updates due removed.',2],'Remove takes the widget off the draft and the others move up');
ui.entry('offline','Remove').onSelect();
check([ui.shown().length,ui.said()],[10,'Offline devices removed.'],'Remove of the menu does the same');

// ---- the catalog ----
check(ui.catalog().open,false,'the catalog is closed until Add widget…');
ui.button('Add widget…').props.onClick();
check([ui.catalog().open,short(ui.catalog().draft).length,ui.catalog().available.length,ui.catalog().available.includes('customers'),ui.catalog().available.includes('activity')],[true,10,22,false,false],'Add widget… opens the catalog with the draft and the widgets this viewer can use');
view=ui.catalogView();
check([view.props.modal,view.props.title,view.props.description],[false,'Add widget','Choose what your dashboard shows. A new widget goes to the end of the dashboard.'],'a non-modal kit Drawer with its title and description');
check(catalogHarness.walk(view).filter(node=>node.type==='h3').map(node=>node.props.children),['Monitoring','Devices','Updates and lifecycle','Security','Hardware','Activity'],'the widgets stand in six groups');
const rows=ui.catalogRows();
check([rows.length,rows.find(([name])=>name==='Open alarms'),rows.find(([name])=>name==='Updates due'),rows.find(([name])=>name==='Device health')],[22,['Open alarms',true,'Remove Open alarms'],['Updates due',false,'Add Updates due'],['Device health',false,'Add Device health']],'a row per widget: on the draft it offers Remove, else Add; the button names its widget');
ok(catalogHarness.text(view).includes('On the dashboard')&&catalogHarness.text(view).includes('Devices with warning or critical alarms, the worst first.'),'a row says when its widget is on the dashboard and what the widget shows');
ui.catalog().onAdd('health');
check([ui.shown().at(-1),ui.shown().length,ui.said(),ui.catalogRows().find(([name])=>name==='Device health')],['health:1x2',11,'Device health added.',['Device health',true,'Remove Device health']],'Add appends the widget in its default size, says so, and the row offers Remove');
ui.catalog().onAdd('updates');ui.catalog().onRemove('health');
check([ui.shown().at(-1),ui.shown().length,ui.said()],['updates:1x2',11,'Device health removed.'],'a removed widget can be added again (at the end); the catalog removes too');
// The search of the catalog.
const search=text=>{catalogHarness.find(ui.catalogView(),node=>node.props.search).props.search.onChange(text);return ui.catalogRows().map(([name])=>name);};
check([search('alarm'),search('BITLOCKER'),search('  jobs ')],[['Open alarms','Alarms in the last 7 days','Alarms per day','Device health'],['Drive encryption'],['Recent jobs','Failed jobs']],'the search finds a widget by its name or its description, in any case');
check([search('weather'),!!catalogHarness.find(ui.catalogView(),node=>node.props.title==='No widget matches your search'),!!catalogHarness.button(ui.catalogView(),'Clear search')],[[],true,true],'no match: the empty state offers Clear search');
catalogHarness.button(ui.catalogView(),'Clear search').props.onClick();
check(ui.catalogRows().length,22,'Clear search shows every widget again');
ui.catalog().onClose();
check([ui.catalog().open,ui.board()['data-editing'],ui.shown().length],[false,true,11],'closing the catalog keeps the edit mode and the draft');

// ---- Save ----
const edited=ui.shown();
await ui.save();
check([ui.saves,ui.kept.length,short(ui.kept[0].own),page.toasts],[[['own',edited]],1,edited,['Layout saved.']],'Save sends the draft as the own layout, keeps the answer and confirms');
check([ui.board()['data-editing'],ui.shown(),!!ui.button('Customize'),ui.said(),ui.catalog()],[undefined,edited,true,'',undefined],'the edit mode ends and the page keeps the saved layout');

// ---- Reset to default stores no layout ----
ui.customize();
check([ui.shown(),ui.button('Save').props.blocked,page.menu(ui.header(),'More actions')[0].blocked],[edited,'No changes.',undefined],'the next edit starts from the own layout; the reset is free');
page.menu(ui.header(),'More actions')[0].onSelect();
check([ui.shown(),ui.button('Save').props.variant,page.menu(ui.header(),'More actions')[0].blocked],[builtIn,'primary','You already use the default layout.'],'Reset to default: the default layout as the draft');
await ui.save();
check([ui.saves[1],ui.kept[1].own,ui.shown()],[['own',null],null,builtIn],'Save stores null: the account follows the default again');

// ---- an empty board ----
ui=start();ui.customize();
for(const id of builtInDashboardLayout.map(item=>item.id))ui.controls(id).onRemove();
check([ui.shown(),!!page.find(ui.tree(),node=>node.props.title==='No widgets on your dashboard')],[[],true],'every widget removed: the empty state');
await ui.save();
check([ui.saves,ui.kept[0].own],[[['own',[]]],[]],'Save stores the empty board as an own layout');
page.button(ui.tree(),'Add widget…').props.onClick();
check([ui.board()['data-editing'],ui.catalog().open],[true,true],'"Add widget…" of the empty state turns the edit mode on and opens the catalog');

// ---- a failed save keeps the edit mode and the draft ----
ui=start();ui.customize();ui.controls('jobs').onMove(0);
ui.state.fail='The data storage cannot be reached.';
await ui.save();
check([ui.saves.length,ui.kept,page.toasts,ui.board()['data-editing'],ui.button('Save').props.loading,ui.shown()[0]],[1,[],['error:The data storage cannot be reached.'],true,false,'jobs:2x2'],'a failed save: the error, the edit mode and the draft stay');
ui.state.fail='';
await ui.save();
check([ui.saves.length,ui.board()['data-editing'],page.toasts.at(-1)],[2,undefined,'Layout saved.'],'the retry saves');

// ---- Cancel ----
ui=start();ui.customize();
ui.button('Cancel').props.onClick();
check([ui.board()['data-editing'],ui.confirm().open,ui.saves],[undefined,false,[]],'Cancel without a change leaves the edit mode at once');
ui.customize();ui.controls('jobs').onRemove();
ui.button('Cancel').props.onClick();
const confirm=ui.confirm();
check([ui.board()['data-editing'],confirm.open,confirm.title,confirm.body,confirm.confirmLabel,confirm.cancelLabel,confirm.tone],[true,true,'Discard changes?','Your changes to the layout are not saved.','Discard','Keep editing','danger'],'Cancel with a changed draft asks first');
confirm.onOpenChange(false);
check([ui.confirm().open,ui.board()['data-editing'],ui.shown().length],[false,true,11],'Keep editing: the edit mode and the draft stay');
ui.button('Cancel').props.onClick();ui.confirm().onConfirm();
check([ui.confirm().open,ui.board()['data-editing'],ui.shown(),ui.saves],[false,undefined,builtIn,[]],'Discard: the stored layout is back and nothing is sent');

// ---- a widget the viewer cannot use stays in the layout ----
const withCustomers=[{id:'customers',w:2,h:2},{id:'status',w:1,h:1},{id:'alarms',w:2,h:2}];
ui=start({preference:{own:withCustomers,default:builtInDashboardLayout}});
check(ui.shown(),['status:1x1','alarms:2x2'],'Customers does not show with a single customer');
ui.customize();
check([ui.controls('status').index,ui.controls('status').total,ui.entry('status','Move earlier').blocked],[0,2,'This widget is already first.'],'the places count the shown widgets');
ui.controls('alarms').onMove(0);
await ui.save();
check(ui.saves,[['own',['customers:2x2','alarms:2x2','status:1x1']]],'the saved layout keeps the widget that does not show');
ui=start({preference:{own:withCustomers,default:builtInDashboardLayout},customers:[{id:'k1',name:'Kiwi'},{id:'k2',name:'Apple'}],owner:true});
ui.customize();ui.button('Add widget…').props.onClick();
check([ui.shown()[0],ui.catalog().available.length,ui.catalog().available],['customers:2x2',24,[...dashboardWidgetIds]],'with two customers and as Owner every widget shows and the catalog offers all 24');

// ---- the grid follows its columns ----
ui=start({preference:{own:[{id:'jobs',w:4,h:2},{id:'alarm-week',w:3,h:2},{id:'status',w:1,h:1}],default:builtInDashboardLayout}});
// The second state cell of the page is the measured column count (use-grid-columns.ts).
page.reset({1:2});
check([ui.shown(),ui.board()['data-columns']],[['jobs:2x2','alarm-week:2x2','status:1x1'],2],'two columns: a widget shows no wider than the grid, and its content follows the shown size');
ok(page.walk(ui.tree()).filter(node=>node.props.size&&node.props.onNavigate).every(node=>node.props.size.w<=2),'the widgets get the shown size');

// ---- the Owner's default layout ----
const portalDefault=[{id:'offline',w:2,h:2},{id:'alarms',w:2,h:2},{id:'status',w:1,h:1}];
ui=start({owner:true,preference:{own:null,default:portalDefault}});
check([ui.shown(),page.menu(ui.header(),'More actions').map(entry=>entry.label)],[short(portalDefault),['Edit default layout']],'the page shows the Owner default; the Owner menu');
page.menu(ui.header(),'More actions')[0].onSelect();
check([ui.board()['data-editing'],ui.note().startsWith('You are editing the default layout. Accounts without their own layout see it.'),page.menu(ui.header(),'More actions').map(entry=>[entry.label,entry.blocked])],[true,true,[['Restore original layout',undefined]]],'the default mode: its notice and Restore original layout');
ui.controls('status').onMove(0);
check(ui.shown(),['status:1x1','offline:2x2','alarms:2x2'],'the page shows the default draft');
await ui.save();
check([ui.saves,page.toasts,short(ui.kept[0].default)],[[['default',['status:1x1','offline:2x2','alarms:2x2']]],['Default layout saved.'],['status:1x1','offline:2x2','alarms:2x2']],'Save sends the default layout and confirms');
page.menu(ui.header(),'More actions')[0].onSelect();
page.menu(ui.header(),'More actions')[0].onSelect();
check([ui.shown(),page.menu(ui.header(),'More actions')[0].blocked],[builtIn,'This is the original layout.'],'Restore original layout: the built-in layout, then blocked');
await ui.save();
check(ui.saves[1],['default',null],'the original layout is stored as no default');
ok(!page.menu(start().header(),'More actions'),'no menu for an account that is no Owner');

// ---- sample devices and the palette request ----
ui=start({demo:true,owner:true});
check([ui.button('Customize').props.blocked,page.menu(ui.header(),'More actions')],['Not available for sample devices.',undefined],'sample devices: Customize is blocked, no Owner menu');
ui.customize();
check(ui.board()['data-editing'],undefined,'a blocked Customize changes nothing');
ui=start();ui.tree();await page.flush();
check(ui.board()['data-editing'],undefined,'the first render does not edit');
ui.state.props={...ui.state.props,customizeRequest:1};ui.tree();await page.flush();
check(ui.board()['data-editing'],true,'a new palette request turns the edit mode on');
ui=start({demo:true});ui.tree();await page.flush();
ui.state.props={...ui.state.props,customizeRequest:1};ui.tree();await page.flush();
check(ui.board()['data-editing'],undefined,'not for sample devices');

// ---- the alarm week load ----
ui=start();
const weekState=(type=AlarmWeekWidget)=>page.find(ui.tree(),node=>node.type===type).props.state;
check([weekState().week,weekState().loading,ui.loads.length],[null,true,0],'before the load: loading');
await page.flush();
check([ui.loads.length,weekState().week,weekState().loading],[1,{start:0,hours:[]},false],'one load on mount');
ui.tree();await page.flush();
check(ui.loads.length,1,'a render without a change loads nothing');
ui.state.props={...ui.state.props,refreshKey:1};
check(weekState().loading,true,'a console refresh: loading again, the counts stay');
ok(weekState().week,'the counts stay during the reload');
await page.flush();
check(ui.loads.length,2,'the refresh loads again');
weekState().retry();ui.tree();await page.flush();
check(ui.loads.length,3,'retry loads again');
ui=start({loadWeek:async()=>{throw new Error('The portal cannot be reached.');}});
ui.tree();await page.flush();
check([weekState().week,weekState().error,weekState().loading],[null,'The portal cannot be reached.',false],'a failed load reports its text');
ui=start({preference:{own:[{id:'status',w:1,h:1}],default:builtInDashboardLayout}});
ui.tree();await page.flush();
check(ui.loads.length,0,'without one of the two alarm week widgets on the board nothing loads');
ui=start({preference:{own:[{id:'alarm-trend',w:1,h:1},{id:'alarm-week',w:2,h:2}],default:builtInDashboardLayout}});
ui.tree();await page.flush();
check([ui.loads.length,weekState(AlarmTrendWidget).week,weekState(AlarmTrendWidget)===weekState(AlarmWeekWidget)||weekState(AlarmTrendWidget).week===weekState(AlarmWeekWidget).week],[1,{start:0,hours:[]},true],'Alarms per day and the heatmap share one request');
ui=start({demo:true});ui.tree();await page.flush();
check([ui.loads.length,weekState().week.hours.length,weekState().loading],[0,192,false],'sample devices: the sample week, no request');

// ---- focus and reveal: after a step the focus goes to the control that took it ----
// The page focuses by element id in a layout effect; this harness runs layout effects and records the ids.
{
 const focusPage=panelHarness({hooked:['ui/devices/dashboard/dashboard-view.tsx',...hooks],locale:'en',layoutEffects:true});
 const View=focusPage.load('ui/devices/dashboard/dashboard-view.tsx').default,{WidgetEditControls:Controls}=focusPage.load('ui/devices/dashboard/dashboard-edit.tsx'),{DashboardCatalogDrawer:Catalog}=focusPage.load('ui/devices/dashboard/dashboard-catalog-drawer.tsx');
 const focused=[],revealed=[],hadDocument='document' in globalThis,previousDocument=globalThis.document;
 globalThis.document={getElementById:id=>({focus:()=>focused.push(id),scrollIntoView:()=>revealed.push(id)})};
 try{
  const props={header:(actions,primary)=>({type:'header',props:{children:[actions,primary]}}),servers:[device('A')],jobs:[],viewer:{id:'u1',label:'Anna',permissions:['*']},demo:false,saving:false,narrow:false,owner:false,
   preference:{own:[{id:'alarms',w:2,h:2},{id:'status',w:1,h:1},{id:'jobs',w:2,h:2}],default:builtInDashboardLayout},refreshKey:0,customizeRequest:0,onNavigate(){},onAddDevice(){},onSelectJob(){},onCancelJob(){},
   onPreference(next){props.preference=next;},saveLayout:async(mode,layout)=>({own:layout,default:builtInDashboardLayout}),loadWeek:async()=>({start:0,hours:[]})};
  const tree=()=>focusPage.tree(View,props),controls=id=>focusPage.walk(tree()).find(node=>node.type===Controls&&node.props.widget.id===id).props;
  const step=async action=>{focused.length=0;revealed.length=0;action();tree();await focusPage.flush();return [[...focused],[...revealed]];};
  check(await step(()=>{}),[[],[]],'a render without a step moves no focus');
  check(await step(()=>focusPage.button(tree(),'Customize').props.onClick()),[['dashboard-add-widget'],[]],'Customize: the focus goes to "Add widget…" (Customize left the header)');
  check(await step(()=>controls('alarms').onMove(1)),[[moveHandleId('alarms')],[]],'a move: the focus stays on the move handle of the moved widget');
  check(await step(()=>controls('alarms').onResize('wider')),[[],[]],'a resize moves no focus: the handle stays where it is');
  check(await step(()=>controls('status').onRemove()),[[moveHandleId('alarms')],[]],'Remove: the focus goes to the move handle of the next widget');
  check(await step(()=>controls('jobs').onRemove()),[[moveHandleId('alarms')],[]],'Remove of the last widget: the one before it');
  check(await step(()=>controls('alarms').onRemove()),[['dashboard-add-widget'],[]],'Remove of the only widget: "Add widget…"');
  const catalog=()=>focusPage.find(tree(),node=>node.type===Catalog).props;
  check(await step(()=>catalog().onAdd('health')),[[],['dashboard-cell-health']],'Add: the new widget scrolls into view; the focus stays in the catalog');
  check(await step(()=>catalog().onRemove('health')),[[],[]],'Remove from the catalog keeps the focus on its button');
  focused.length=0;catalog().onAdd('status');focusPage.button(tree(),'Save').props.onClick();await focusPage.settle();tree();await focusPage.flush();
  check(focused.at(-1),'dashboard-customize','Save: the edit mode ends and the focus returns to Customize');
  check(await step(()=>{focusPage.button(tree(),'Customize').props.onClick();focusPage.button(tree(),'Cancel').props.onClick();}),[['dashboard-customize'],[]],'Cancel: the focus returns to Customize');
 }finally{if(hadDocument)globalThis.document=previousDocument;else delete globalThis.document;}
}

console.log(`dashboard edit: ${checks} checks passed`);
