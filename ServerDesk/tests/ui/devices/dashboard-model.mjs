// The pure rules of the Dashboard (ui/devices/dashboard/dashboard-model.ts, docs/dashboard.md): the status line (the
// first match of no device, a critical alarm, an alarm, an offline device, fine; revoked devices are not counted; a
// device that never connected or is in maintenance is neither online nor offline), the numbers and the order of the
// first widgets, the heatmap grid (seven local days of 24 hours from UTC hour counts, future cells, the five steps,
// the busiest hour, a time zone with a half-hour offset and a day with a clock change), the sample week, the grid
// (columns by width, the shown size, what a widget shows at a size, which widgets a viewer can use), and the rules
// of the edit mode (what Save stores, when the draft is dirty, what the page shows, a resize step and its limits,
// the size a resize drag asks for, and the place a moved widget takes).
import '../../support/register.mjs';
import assert from 'node:assert/strict';
const model=await import('../../../ui/devices/dashboard/dashboard-model.ts');
const {builtInDashboardLayout,moveDashboardWidget,removeDashboardWidget}=await import('../../../lib/dashboard-layout.ts');
const {dashboardStatus,alarmsWidget,offlineWidget,updatesWidget,jobsWidget,alarmWeekGrid,alarmWeekStart,demoAlarmWeek,startLayoutEdit,layoutSaveValue,layoutDirty,shownDashboardLayout,
 dashboardGridColumns,shownWidgetSize,widgetShape,widgetAvailable,resizeStep,resizeTarget,dragStarted,dragOver,dragThreshold}=model;
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const ok=(value,label)=>{assert.ok(value,label);checks++;};

const minute=60_000,hour=3_600_000,now=Date.UTC(2026,10,18,14,20);
let alertId=0;
const alert=(level,startedAt=now-hour)=>({id:'a'+(++alertId),ruleId:'cpu-usage',key:'',level,peakLevel:level,peakValue:null,threshold:null,params:{},startedAt,openedAt:startedAt,acknowledged:null,muted:null});
const device=(name,extra={})=>({id:name.toLowerCase(),name,createdAt:0,lastSeen:now-30_000,revoked:0,management:1,snapshot:null,...extra});
const updates=(pendingCount,rebootPending=false)=>({updates:{checkedAt:'',pendingCount,items:[]},rebootPending});

// ---- the status line ----
const status=servers=>{const {tone,headline,counts}=dashboardStatus(servers,now);return [tone,headline,counts];};
check(status([]),['neutral','none',{devices:0,online:0,offline:0,alarms:0,critical:0,warning:0}],'no device');
check(status([device('Gone',{revoked:1,alerts:[alert('critical')]})]),['neutral','none',{devices:0,online:0,offline:0,alarms:0,critical:0,warning:0}],'a revoked device is not counted');
check(status([device('A'),device('B')]),['success','fine',{devices:2,online:2,offline:0,alarms:0,critical:0,warning:0}],'everything runs');
check(status([device('A'),device('B',{lastSeen:now-5*minute})]),['warning','offline',{devices:2,online:1,offline:1,alarms:0,critical:0,warning:0}],'an offline device');
check(status([device('A',{alerts:[alert('info')]}),device('B',{lastSeen:now-5*minute})]),['warning','alarms',{devices:2,online:1,offline:1,alarms:1,critical:0,warning:0}],'an open alarm comes before an offline device');
check(status([device('A',{alerts:[alert('warning'),alert('critical')]}),device('B',{alerts:[alert('warning')]})]),['danger','alarms',{devices:2,online:2,offline:0,alarms:3,critical:1,warning:2}],'a critical alarm sets the danger tone');
check(status([device('New',{lastSeen:null}),device('Updating',{lastSeen:now-9*minute,maintenance:{state:'updating'}})]),['success','fine',{devices:2,online:0,offline:0,alarms:0,critical:0,warning:0}],'never connected and in maintenance: neither online nor offline');
check(dashboardStatus([device('A',{lastSeen:now-120_000})],now).counts.offline,1,'the online window ends at two minutes');

// ---- Open alarms ----
const alarmServers=[
 device('B',{alerts:[alert('warning',now-3*hour),alert('info',now-9*hour)]}),
 device('A',{alerts:[alert('critical',now-hour),alert('warning',now-5*hour),alert('critical',now-2*hour)]}),
 device('C',{alerts:[alert('warning',now-4*hour),alert('info',now-hour)]}),
 device('Gone',{revoked:1,alerts:[alert('critical')]}),
];
const alarms=alarmsWidget(alarmServers);
check([alarms.count,alarms.levels,alarms.rows.length],[7,{critical:2,warning:3,info:2},7],'all open alarms counted by level; every alarm is a row (the widget shows what its size holds)');
check(alarms.rows.slice(0,5).map(row=>[row.alert.level,row.device.name,(now-row.alert.startedAt)/hour]),[['critical','A',2],['critical','A',1],['warning','A',5],['warning','C',4],['warning','B',3]],'critical first, then the oldest');
check(alarmsWidget([device('A')]),{count:0,levels:{critical:0,warning:0,info:0},rows:[]},'no alarm');

// ---- Offline devices ----
const offlineServers=[device('On'),device('Never',{lastSeen:null}),...['F','E','D','C','B','A'].map((name,index)=>device(name,{lastSeen:now-(index+1)*hour})),device('Gone',{revoked:1,lastSeen:now-99*hour})];
const offline=offlineWidget(offlineServers,now);
check([offline.count,offline.devices,offline.rows.map(row=>[row.device.name,(now-row.since)/hour])],[6,8,[['A',6],['B',5],['C',4],['D',3],['E',2],['F',1]]],'six offline of eight devices; the longest offline first');
check(offlineWidget([device('B',{lastSeen:now-hour}),device('A',{lastSeen:now-hour})],now).rows.map(row=>row.device.name),['A','B'],'the same time: by name');
check(offlineWidget([device('A')],now),{count:0,devices:1,rows:[]},'all online');

// ---- Updates due ----
const updateServers=[device('S1',{snapshot:updates(3)}),device('S2',{snapshot:updates(12,true)}),device('S3',{snapshot:updates(0,true)}),device('S4'),device('S5',{snapshot:updates(3)}),device('S6',{snapshot:updates(1)}),device('S7',{snapshot:updates(7)}),device('S8',{snapshot:updates(2)}),device('Gone',{revoked:1,snapshot:updates(50)})];
const due=updatesWidget(updateServers);
check([due.count,due.devices,due.rows.map(row=>[row.device.name,row.pending,row.restart])],[28,6,[['S2',12,true],['S7',7,false],['S1',3,false],['S5',3,false],['S8',2,false],['S6',1,false]]],'28 pending updates on six devices; the most pending first, then by name');
check(updatesWidget([device('A',{snapshot:updates(0)}),device('B',{snapshot:{updates:{pendingCount:'x'}}}),device('C')]),{count:0,devices:0,rows:[]},'no update due; a device without a count or with an unreadable one is left out');

// ---- Recent jobs ----
const job=(state,extra={})=>({id:state+Math.random(),serverId:'a',action:'restart-service',target:'',state,createdAt:now,claimedAt:null,result:null,actor:'x',...extra});
check(jobsWidget([job('running'),job('running'),job('pending'),job('pending',{notBefore:now+hour}),job('succeeded'),job('failed')],now),{active:3,running:2,waiting:1},'running and due jobs are active; a scheduled one is not');
check(jobsWidget([],now),{active:0,running:0,waiting:0},'no job');

// ---- the heatmap grid ----
// A fixed time zone for the grid: the offset in ms east of UTC.
const zone=offset=>(time,dayOffset,localHour)=>{const local=new Date(time+offset);return Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate()+dayOffset,localHour)-offset;};
const week=(counts={})=>{const start=alarmWeekStart(now),hours=new Array(192).fill(0);for(const [at,count] of Object.entries(counts))hours[Math.floor((Number(at)-start)/hour)]=count;return {start,hours};};
check([alarmWeekStart(now),alarmWeekStart(now)%hour],[Date.UTC(2026,10,18,14)-191*hour,0],'the window starts 191 full hours before the current hour');
const utc=zone(0);
let grid=alarmWeekGrid(week(),now,utc);
check([grid.days.length,grid.days.every(day=>day.cells.length===24),grid.total,grid.max,grid.busiest],[7,true,0,0,null],'seven days of 24 cells; an empty week has no busiest hour');
check([grid.days[0].at,grid.days[6].at],[Date.UTC(2026,10,12),Date.UTC(2026,10,18)],'six days ago to today');
check([grid.days[6].cells.filter(cell=>cell.future).map(cell=>cell.hour),grid.days[5].cells.some(cell=>cell.future)],[[15,16,17,18,19,20,21,22,23],false],'the cells after the current hour are future, the current hour is not');
grid=alarmWeekGrid(week({[Date.UTC(2026,10,17,14)]:8,[Date.UTC(2026,10,18,9)]:2,[Date.UTC(2026,10,12,0)]:1,[Date.UTC(2026,10,15,23)]:5,[Date.UTC(2026,10,16,3)]:3,[Date.UTC(2026,10,11,23)]:9}),now,utc);
check([grid.total,grid.max,[grid.busiest.at,grid.busiest.end,grid.busiest.count]],[19,8,[Date.UTC(2026,10,17,14),Date.UTC(2026,10,17,15),8]],'the total of the seven days (an hour before them is not counted), the busiest hour');
const cell=(day,hourOfDay)=>grid.days[day].cells[hourOfDay];
check([cell(5,14),cell(6,9),cell(0,0),cell(3,23),cell(4,3),cell(2,12)].map(item=>[item.count,item.step]),[[8,4],[2,1],[1,1],[5,3],[3,2],[0,0]],'the steps: 0 without an alarm, else 1 to 4 by the share of the busiest cell');
grid=alarmWeekGrid(week({[Date.UTC(2026,10,17,14)]:1}),now,utc);
check([grid.busiest.count,grid.days[5].cells[14].step],[1,4],'one alarm alone is the busiest cell at step 4');
// A zone east of UTC: the local day starts earlier, so the same UTC hour lands in another row and column.
grid=alarmWeekGrid(week({[Date.UTC(2026,10,17,23)]:4}),now,zone(2*hour));
check([grid.days[6].at,grid.days[6].cells[1].count,grid.days[5].cells[23].count,grid.total],[Date.UTC(2026,10,17,22),4,0,4],'UTC+2: 23:00 UTC is 01:00 of the next local day');
// A half-hour offset: a cell covers the UTC hour that holds its start.
grid=alarmWeekGrid(week({[Date.UTC(2026,10,17,8)]:2}),now,zone(5.5*hour));
check([grid.days[5].cells[14].count,grid.days[5].cells[13].count,grid.total],[2,0,2],'UTC+5:30: the cell that starts at 08:30 UTC holds the 08:00 UTC hour, counted once');
// A day with a clock change: a local hour that does not exist starts where the next one does, so it covers no hour.
const skipping=(time,dayOffset,localHour)=>utc(time,dayOffset,dayOffset===-2&&localHour===2?3:localHour);
grid=alarmWeekGrid(week({[Date.UTC(2026,10,16,2)]:6,[Date.UTC(2026,10,16,3)]:1}),now,skipping);
check([grid.days[4].cells[1].count,grid.days[4].cells[2].count,grid.days[4].cells[3].count,grid.total],[6,0,1,7],'a skipped local hour is an empty cell; the hour before it takes the alarms up to the next start, every hour counts once');
check(alarmWeekGrid({start:0,hours:[]},now,utc).total,0,'counts outside the window are zero');
check(alarmWeekGrid({start:alarmWeekStart(now),hours:['3',-2,null,NaN]},now,utc).total,0,'a broken count never goes below zero (the first hours lie before the seven days)');

// ---- the sample week ----
const sample=demoAlarmWeek(now);
check([sample.start,sample.hours.length,demoAlarmWeek(now)],[alarmWeekStart(now),192,sample],'the sample week has the server window and is a pure function of now');
const sampleGrid=alarmWeekGrid(sample,now,utc);
ok(sampleGrid.total>10&&sampleGrid.busiest&&sampleGrid.max<=3,'the sample week has alarms and a busiest hour');
ok(sample.hours.every(count=>Number.isInteger(count)&&count>=0),'whole counts');

// ---- the grid: columns, the shown size, what a widget shows at a size ----
check([1440,1100,1099,620,619,390,0].map(dashboardGridColumns),[4,4,2,2,1,1,1],'4 columns from 1100px, 2 from 620px, else 1');
check([shownWidgetSize({w:4,h:2},4),shownWidgetSize({w:4,h:2},2),shownWidgetSize({w:3,h:3},1),shownWidgetSize({w:1,h:1},4)],[{w:4,h:2},{w:2,h:2},{w:1,h:3},{w:1,h:1}],'a widget is never wider than the grid; its height stays');
const shape=(w,h)=>{const {rows,split,legend,roomy}=widgetShape({w,h});return [rows,split,legend,roomy];};
check([shape(1,1),shape(2,1),shape(4,1)],[[0,false,false,false],[2,true,true,false],[2,true,true,false]],'one row high: the lead alone at 1 x 1; from two columns two list rows and the legend beside it');
check([shape(1,2),shape(2,2),shape(1,3),shape(2,3)],[[4,false,true,true],[4,false,true,true],[8,false,true,true],[8,false,true,true]],'two and three rows high: 4 and 8 list rows below the lead, the full empty state fits');
check([shape(3,2),shape(4,2),shape(3,3),shape(4,3)],[[6,true,true,true],[6,true,true,true],[10,true,true,true],[10,true,true,true]],'from three columns the list has its own column: 6 and 10 rows');
ok([1,2,3].every(h=>[1,2,3].every(w=>widgetShape({w:w+1,h}).rows>=widgetShape({w,h}).rows))&&[1,2,3,4].every(w=>[1,2].every(h=>widgetShape({w,h:h+1}).rows>widgetShape({w,h}).rows)),'a larger widget never shows fewer rows, and a taller one always more');
const anyone={customers:1,audit:false};
check(['alarms','customers','activity'].map(id=>[widgetAvailable(id,anyone),widgetAvailable(id,{customers:2,audit:false}),widgetAvailable(id,{customers:0,audit:true})]),[[true,true,true],[false,true,false],[false,false,true]],'Customers needs two visible customers, Recent activity an account that may read audit entries; every other widget shows');

// ---- the edit mode: the draft ----
const custom=moveDashboardWidget(builtInDashboardLayout,'jobs',0),portalDefault=removeDashboardWidget(builtInDashboardLayout,'updates');
const following={own:null,default:portalDefault},owning={own:custom,default:portalDefault};
check([startLayoutEdit('own',following),startLayoutEdit('own',owning),startLayoutEdit('default',owning)],[{mode:'own',draft:portalDefault,follow:true},{mode:'own',draft:custom,follow:false},{mode:'default',draft:portalDefault,follow:false}],'the draft the edit mode starts with');
let edit=startLayoutEdit('own',following);
check([layoutDirty(edit,following),layoutSaveValue(edit,following)],[false,null],'own, following the default: clean');
edit={...edit,draft:custom,follow:false};
check([layoutDirty(edit,following),layoutSaveValue(edit,following)],[true,custom],'a moved widget: dirty, Save stores the draft');
edit={...edit,draft:portalDefault};
check([layoutDirty(edit,following),layoutSaveValue(edit,following)],[false,null],'moved back: the account still follows the default');
edit=startLayoutEdit('own',owning);
check([layoutDirty(edit,owning),layoutSaveValue(edit,owning)],[false,custom],'own layout: clean');
edit={...edit,draft:portalDefault,follow:true};
check([layoutDirty(edit,owning),layoutSaveValue(edit,owning)],[true,null],'Reset to default: dirty, Save stores no layout');
edit={...edit,follow:false};
check([layoutDirty(edit,owning),layoutSaveValue(edit,owning)],[true,portalDefault],'the default layout chosen by hand stays an own layout');
edit={...edit,draft:[]};
check([layoutDirty(edit,owning),layoutSaveValue(edit,owning)],[true,[]],'every widget removed: Save stores the empty board');
edit=startLayoutEdit('default',owning);
check([layoutDirty(edit,owning),layoutSaveValue(edit,owning)],[false,portalDefault],'default mode: clean');
edit={...edit,draft:builtInDashboardLayout};
check([layoutDirty(edit,owning),layoutSaveValue(edit,owning)],[true,null],'the original layout: Save stores none');
check([shownDashboardLayout(owning,null),shownDashboardLayout(following,null),shownDashboardLayout(owning,edit)],[custom,portalDefault,builtInDashboardLayout],'the page shows the draft while the edit mode is on, else the account layout');

// ---- the edit mode: a resize step (the menu and the arrow keys) ----
const sized=(id,w,h)=>({id,w,h});
check([resizeStep(sized('jobs',2,2),'wider',4),resizeStep(sized('jobs',2,2),'narrower',4),resizeStep(sized('jobs',2,2),'taller',4),resizeStep(sized('jobs',2,2),'shorter',4)],[{w:3,h:2},{w:1,h:2},{w:2,h:3},{w:2,h:1}],'one step in each direction');
check([resizeStep(sized('jobs',4,3),'wider',4),resizeStep(sized('jobs',1,1),'narrower',4),resizeStep(sized('jobs',4,3),'taller',4),resizeStep(sized('jobs',1,1),'shorter',4)],[{blocked:'widest'},{blocked:'narrowest'},{blocked:'tallest'},{blocked:'shortest'}],'a step at a limit is blocked with its reason');
check([resizeStep(sized('alarm-week',2,2),'narrower',4),resizeStep(sized('alarm-week',2,2),'shorter',4)],[{blocked:'narrowest'},{blocked:'shortest'}],'the heatmap stays at least 2 x 2');
check([resizeStep(sized('jobs',4,2),'wider',2),resizeStep(sized('jobs',4,2),'narrower',2),resizeStep(sized('jobs',4,2),'taller',2)],[{blocked:'widest'},{w:1,h:2},{w:4,h:3}],'two columns: a stored width of 4 shows as 2, narrower steps from the shown width, and a step in the height keeps the stored width');
check([resizeStep(sized('jobs',2,2),'wider',1),resizeStep(sized('jobs',2,2),'narrower',1),resizeStep(sized('jobs',2,2),'taller',1)],[{blocked:'columns'},{blocked:'columns'},{w:2,h:3}],'one column: the width cannot change, the height can');

// ---- the edit mode: a resize drag ----
const gridCell={width:300,height:184,gap:16};
check([resizeTarget(sized('jobs',2,2),{x:0,y:0},gridCell,4),resizeTarget(sized('jobs',2,2),{x:157,y:99},gridCell,4),resizeTarget(sized('jobs',2,2),{x:159,y:101},gridCell,4),resizeTarget(sized('jobs',2,2),{x:-320,y:-210},gridCell,4)],
 [{w:2,h:2},{w:2,h:2},{w:3,h:3},{w:1,h:1}],'the pointer distance in whole cells: a step from half a cell');
check([resizeTarget(sized('jobs',2,2),{x:5000,y:5000},gridCell,4),resizeTarget(sized('jobs',2,2),{x:-5000,y:-5000},gridCell,4),resizeTarget(sized('jobs',1,1),{x:5000,y:0},gridCell,2)],[{w:4,h:3},{w:1,h:1},{w:2,h:1}],'the drag stays inside the grid and its shown columns');
check([resizeTarget(sized('jobs',4,2),{x:0,y:200},gridCell,2),resizeTarget(sized('jobs',4,2),{x:-316,y:0},gridCell,2)],[{w:4,h:3},{w:1,h:2}],'on a narrower grid a drag in the height keeps the stored width; a drag in the width starts from the shown width');

// ---- the edit mode: a move drag ----
check([dragThreshold,dragStarted({x:3,y:2}),dragStarted({x:4,y:0}),dragStarted({x:-3,y:-3})],[4,false,true,true],'a press becomes a drag after 4px');
const board=[sized('alarms',2,2),sized('offline',1,2),sized('jobs',2,2),sized('status',1,1)],order=layout=>layout.map(item=>item.id);
let drag={layout:board,state:{id:'alarms',origin:board,last:null}};
const over=id=>{drag=dragOver(drag.layout,drag.state,id);return [order(drag.layout),drag.state.last];};
check(over(null),[['alarms','offline','jobs','status'],null],'over no widget: nothing moves');
ok(dragOver(board,drag.state,'alarms').layout===board&&dragOver(board,drag.state,null).state===drag.state,'over the dragged widget or over none, the layout and the state stay the same objects');
check(over('jobs'),[['offline','jobs','alarms','status'],'jobs'],'over another widget: the dragged widget takes its place');
check(over('jobs'),[['offline','jobs','alarms','status'],'jobs'],'the pointer rests on that widget: no trade back');
check(over('alarms'),[['offline','jobs','alarms','status'],null],'the pointer is over the dragged widget: the last place is free again');
check(over('jobs'),[['offline','alarms','jobs','status'],'jobs'],'back over the widget: they trade again');
check(over('status'),[['offline','jobs','status','alarms'],'status'],'on to the last widget');
check(over('weather'),[['offline','jobs','status','alarms'],'status'],'a widget that is not on the board changes nothing');
check([order(drag.state.origin),order(board)],[['alarms','offline','jobs','status'],['alarms','offline','jobs','status']],'the state keeps the layout of the drag start (Escape restores it)');

console.log(`dashboard model: ${checks} checks passed`);
