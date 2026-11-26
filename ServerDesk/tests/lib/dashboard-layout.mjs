// The Dashboard layout rules (lib/dashboard-layout.ts, docs/dashboard.md): the widget ids, the grid and the size range
// of each widget, and the built-in layout; the strict reader of a request body (known widgets, each at most once,
// exactly the keys id, w and h, a whole-number size inside the range); the stored form {version, widgets} and its
// lenient reader (unknown widgets and repeats dropped, sizes brought into the range, a bare array read as a layout of
// the first Dashboard, unreadable JSON is null); the effective layout, the comparisons, and the add, remove, move and resize helpers of
// the edit mode.
import '../support/register.mjs';
import assert from 'node:assert/strict';
const layout=await import('../../lib/dashboard-layout.ts');
const {dashboardLayoutText,dashboardLayoutVersion,dashboardWidgetIds,dashboardColumns,dashboardMaxRows,dashboardWidgetSizes,builtInDashboardLayout,formerDashboardTileIds,isDashboardWidgetId,clampWidgetSize,parseDashboardLayout,storedDashboardLayout,
 effectiveDashboardLayout,sameDashboardLayout,sameDashboardPreference,moveDashboardWidget,resizeDashboardWidget,addDashboardWidget,removeDashboardWidget}=layout;
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
// The same object, not an equal copy: a step that changes nothing must not make the page render or the draft dirty.
const same=(values,expected,label)=>{for(const value of values)assert.equal(value,expected,label);checks++;};
const short=value=>value.map(item=>`${item.id}:${item.w}x${item.h}`);
const w=(id,width,height)=>({id,w:width,h:height});

// ---- ids, grid, sizes, the built-in layout ----
check(dashboardWidgetIds,['alarms','alarm-week','alarm-trend','health','offline','status','pinned','customers','load','disk-space','updates','restart','os-support','agents','defender','encryption','certificates','autostart','disk-health','crashes','jobs','failed-jobs','runbooks','activity'],'the 24 widgets in catalog order');
check([dashboardColumns,dashboardMaxRows],[4,3],'a grid of 4 columns; a widget is at most 3 rows high');
check(Object.keys(dashboardWidgetSizes).sort(),[...dashboardWidgetIds].sort(),'every widget has a size rule');
check(dashboardWidgetIds.filter(id=>dashboardWidgetSizes[id].minW!==1||dashboardWidgetSizes[id].minH!==1),['alarm-week'],'every widget may be 1 x 1 but the heatmap');
check(dashboardWidgetSizes['alarm-week'],{minW:2,minH:2,w:2,h:2},'the heatmap is at least 2 x 2');
check(dashboardWidgetIds.filter(id=>{const {minW,minH,w:width,h:height}=dashboardWidgetSizes[id];return width<minW||height<minH||width>dashboardColumns||height>dashboardMaxRows;}),[],'every default size is inside its range');
check(short(builtInDashboardLayout),['alarms:2x2','offline:1x2','updates:1x2','alarm-week:2x2','jobs:2x2','disk-space:1x2','defender:1x1','encryption:1x1','certificates:1x1','os-support:1x1','restart:1x1','crashes:1x1'],'the built-in layout');
check(builtInDashboardLayout.every(item=>item.w===dashboardWidgetSizes[item.id].w&&item.h===dashboardWidgetSizes[item.id].h),true,'the built-in layout uses the default sizes');
check(formerDashboardTileIds,['alarms','offline','updates','jobs','alarm-week'],'the five tiles of the first Dashboard');
check([isDashboardWidgetId('jobs'),isDashboardWidgetId('disk-space'),isDashboardWidgetId('weather'),isDashboardWidgetId(7)],[true,true,false,false],'isDashboardWidgetId');
check([clampWidgetSize('alarms',9,0),clampWidgetSize('alarm-week',1,1),clampWidgetSize('jobs',3,2),clampWidgetSize('jobs','3',null),clampWidgetSize('status',2.5,2)],[{w:4,h:1},{w:2,h:2},{w:3,h:2},{w:2,h:2},{w:1,h:2}],'clampWidgetSize: into the range; a size that is no whole number is the default');

// ---- the strict reader: a request body ----
const custom=[w('jobs',4,3),w('alarm-week',2,2),w('status',1,1)];
check(parseDashboardLayout(custom),custom,'some widgets in any order and size');
check(parseDashboardLayout([]),[],'an empty board is a layout');
check(parseDashboardLayout(builtInDashboardLayout),builtInDashboardLayout,'the built-in layout');
check(parseDashboardLayout(dashboardWidgetIds.map(id=>w(id,dashboardWidgetSizes[id].w,dashboardWidgetSizes[id].h)))?.length,24,'every widget at once');
const refused={
 'not an array':{0:w('jobs',1,1)},'null':null,'a string':'[]',
 'a repeat':[w('jobs',1,1),w('jobs',2,2)],'an unknown widget':[w('weather',1,1)],'an entry that is no object':['jobs'],'an array entry':[['jobs',1,1]],
 'a missing height':[{id:'jobs',w:1}],'a fourth key':[{id:'jobs',w:1,h:1,x:0}],'a layout of the first Dashboard':[{id:'jobs',shown:true}],
 'a width of 0':[w('jobs',0,1)],'a width of 5':[w('jobs',5,1)],'a height of 4':[w('jobs',1,4)],'a fraction':[w('jobs',1.5,1)],'a size as text':[w('jobs','2',1)],
 'the heatmap below its smallest size':[w('alarm-week',1,2)],'more entries than widgets':[...dashboardWidgetIds,'jobs'].map(id=>w(id,2,2)),
};
for(const [label,value] of Object.entries(refused))check(parseDashboardLayout(value),null,'refused: '+label);

// ---- the stored form and its lenient reader ----
check([dashboardLayoutVersion,dashboardLayoutText(custom),dashboardLayoutText([])],[2,'{"version":2,"widgets":[{"id":"jobs","w":4,"h":3},{"id":"alarm-week","w":2,"h":2},{"id":"status","w":1,"h":1}]}','{"version":2,"widgets":[]}'],'a layout is stored as {version, widgets}');
check([storedDashboardLayout(dashboardLayoutText(custom)),storedDashboardLayout(dashboardLayoutText([])),storedDashboardLayout(dashboardLayoutText(builtInDashboardLayout))],[custom,[],builtInDashboardLayout],'the reader gives back what was stored; an empty board stays empty');
const stored=widgets=>storedDashboardLayout(JSON.stringify({version:2,widgets}));
check(short(stored([w('weather',1,1),w('jobs',9,9),w('jobs',1,1),'x',null,w('alarm-week',1,1),{id:'status',w:2},{id:'load',w:1,h:'tall'}])),['jobs:4x3','alarm-week:2x2','status:2x1','load:1x2'],'unknown widgets, repeats and non-objects are dropped; sizes come into the range; a missing size is the default');
check(short(stored([w('status',1,1)])),['status:1x1'],'no widget is added to a stored layout');
check([storedDashboardLayout('{'),storedDashboardLayout('{"id":"jobs"}'),storedDashboardLayout('{"version":2}'),storedDashboardLayout('{"version":2,"widgets":"jobs"}'),storedDashboardLayout('7'),storedDashboardLayout('null'),storedDashboardLayout(null),storedDashboardLayout(undefined),storedDashboardLayout('')],[null,null,null,null,null,null,null,null,null],'unreadable JSON and anything but the two stored forms is null');
// A layout of the first Dashboard: a bare array with {id, shown} per tile.
const former=(order,hidden=[])=>storedDashboardLayout(JSON.stringify(order.map(id=>({id,shown:!hidden.includes(id)}))));
check(short(former(['jobs','alarm-week','alarms','updates','offline'],['updates'])),['jobs:2x2','alarm-week:2x2','alarms:2x2','offline:1x2'],'a first-Dashboard layout: the shown tiles in their order, each in its default size; a hidden tile is not on the board');
check(short(former(['offline','alarms'])),['offline:1x2','alarms:2x2','updates:1x2','jobs:2x2','alarm-week:2x2'],'a tile that layout does not name is appended, as the first Dashboard read it');
check(short(storedDashboardLayout('[]')),['alarms:2x2','offline:1x2','updates:1x2','jobs:2x2','alarm-week:2x2'],'an empty bare array: the first Dashboard read it as its five tiles');
check(short(storedDashboardLayout(JSON.stringify([{id:'alarms',shown:false},{id:'alarms',shown:true},{id:'weather',shown:true},{id:'status',shown:true},{id:'jobs',shown:'no'},7,w('updates',4,3)]))),['jobs:2x2','updates:1x2','offline:1x2','alarm-week:2x2'],'first-Dashboard layout: the first entry of a tile counts, only shown:false hides, unknown tiles and later widgets are dropped, a size is not read');
check(short(former(formerDashboardTileIds,formerDashboardTileIds)),[],'every tile hidden: an empty board');

// ---- effective layout and comparisons ----
check([effectiveDashboardLayout(custom,builtInDashboardLayout),effectiveDashboardLayout(null,builtInDashboardLayout),effectiveDashboardLayout(undefined,custom)],[custom,builtInDashboardLayout,custom],'the own layout, else the default');
check([sameDashboardLayout(custom,custom.map(item=>({...item}))),sameDashboardLayout(custom,[...custom].reverse()),sameDashboardLayout(custom,custom.map(item=>item.id==='status'?{...item,w:2}:item)),sameDashboardLayout(custom,custom.slice(1)),sameDashboardLayout(null,null),sameDashboardLayout(null,custom),sameDashboardLayout([],[])],
 [true,false,false,false,true,false,true],'sameDashboardLayout: the same widgets, order and sizes');
const preference={own:custom,default:builtInDashboardLayout};
check([sameDashboardPreference(preference,{own:custom.map(item=>({...item})),default:[...builtInDashboardLayout]}),sameDashboardPreference(preference,{own:null,default:builtInDashboardLayout}),sameDashboardPreference({own:null,default:custom},{own:null,default:custom}),sameDashboardPreference(preference,{own:custom,default:custom}),sameDashboardPreference(undefined,preference),sameDashboardPreference(preference,null)],
 [true,false,true,false,false,false],'sameDashboardPreference');

// ---- add, remove, move, resize ----
check(short(addDashboardWidget(custom,'health')),['jobs:4x3','alarm-week:2x2','status:1x1','health:1x2'],'add appends the widget in its default size');
same([addDashboardWidget(custom,'jobs')],custom,'a widget that is on the board is not added again');
check(short(removeDashboardWidget(custom,'alarm-week')),['jobs:4x3','status:1x1'],'remove');
same([removeDashboardWidget(custom,'health')],custom,'removing a widget that is not on the board changes nothing');
check([short(moveDashboardWidget(custom,'status',0)),short(moveDashboardWidget(custom,'jobs',2)),short(moveDashboardWidget(custom,'jobs',1)),short(moveDashboardWidget(custom,'alarm-week',99)),short(moveDashboardWidget(custom,'alarm-week',-5))],
 [['status:1x1','jobs:4x3','alarm-week:2x2'],['alarm-week:2x2','status:1x1','jobs:4x3'],['alarm-week:2x2','jobs:4x3','status:1x1'],['jobs:4x3','status:1x1','alarm-week:2x2'],['alarm-week:2x2','jobs:4x3','status:1x1']],'move puts the widget at a place, brought into the list');
same([moveDashboardWidget(custom,'jobs',0),moveDashboardWidget(custom,'status',2),moveDashboardWidget(custom,'status',7),moveDashboardWidget(custom,'health',0),moveDashboardWidget(custom,'jobs',NaN)],custom,'a move to the own place, of a widget that is not there, or to no place returns the same layout');
check([short(resizeDashboardWidget(custom,'status',3,2)),short(resizeDashboardWidget(custom,'alarm-week',1,1)),short(resizeDashboardWidget(custom,'status',9,9))],
 [['jobs:4x3','alarm-week:2x2','status:3x2'],['jobs:4x3','alarm-week:2x2','status:1x1'],['jobs:4x3','alarm-week:2x2','status:4x3']],'resize brings the size into the range');
same([resizeDashboardWidget(custom,'alarm-week',1,1),resizeDashboardWidget(custom,'jobs',4,3),resizeDashboardWidget(custom,'jobs',9,9),resizeDashboardWidget(custom,'health',2,2)],custom,'a resize that keeps the size, or of a widget that is not there, returns the same layout');
check(custom,[w('jobs',4,3),w('alarm-week',2,2),w('status',1,1)],'no helper changes its input');

console.log(`ok dashboard-layout (${checks} checks)`);
