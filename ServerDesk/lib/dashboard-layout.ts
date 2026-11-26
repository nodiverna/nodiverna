// The layout of the Dashboard (docs/dashboard.md): which widgets are on the board, in which order and in which size.
// An account stores its own layout (account_preferences.dashboard_layout); the Owner stores the default layout for
// accounts without one (dashboard_settings). Shared by the server (request bodies, stored JSON) and the console (the
// page and its edit mode). Pure: no imports.

/** The widgets in catalog order. A new widget is added here and in dashboardWidgetSizes; the catalog then offers it. */
export const dashboardWidgetIds=['alarms','alarm-week','alarm-trend','health','offline','status','pinned','customers','load','disk-space','updates','restart','os-support','agents','defender','encryption','certificates','autostart','disk-health','crashes','jobs','failed-jobs','runbooks','activity'] as const;
export type DashboardWidgetId=typeof dashboardWidgetIds[number];
/** The grid: a widget is 1 to 4 columns wide and 1 to 3 rows high. */
export const dashboardColumns=4,dashboardMaxRows=3;
export type DashboardWidgetSize={w:number;h:number};
/** One widget on the board: w columns wide, h rows high. */
export type DashboardWidget={id:DashboardWidgetId}&DashboardWidgetSize;
/** The widgets on the board in display order, each id at most once. A widget that is not listed is not on the board. */
export type DashboardLayout=readonly DashboardWidget[];
/** What GET /api/console carries as preferences.dashboard: the account's own layout (null: it follows the default) and the default layout. */
export type DashboardPreference={own:DashboardLayout|null;default:DashboardLayout};

const size=(w:number,h:number,minW=1,minH=1)=>({minW,minH,w,h});
/** The smallest and the default size of each widget; the largest is the whole grid (dashboardColumns by dashboardMaxRows). */
export const dashboardWidgetSizes:Readonly<Record<DashboardWidgetId,{minW:number;minH:number;w:number;h:number}>>={
 alarms:size(2,2),'alarm-week':size(2,2,2,2),'alarm-trend':size(1,1),health:size(1,2),offline:size(1,2),status:size(1,1),pinned:size(1,2),customers:size(2,2),load:size(1,2),'disk-space':size(1,2),
 updates:size(1,2),restart:size(1,1),'os-support':size(1,1),agents:size(1,1),defender:size(1,1),encryption:size(1,1),certificates:size(1,1),autostart:size(1,1),'disk-health':size(1,1),crashes:size(1,1),
 jobs:size(2,2),'failed-jobs':size(1,2),runbooks:size(1,2),activity:size(2,2),
};
export const isDashboardWidgetId=(value:unknown):value is DashboardWidgetId=>typeof value==='string'&&(dashboardWidgetIds as readonly string[]).includes(value);
const whole=(value:unknown):value is number=>typeof value==='number'&&Number.isInteger(value);
/** The size a widget may have that is nearest to w by h; a size that is not a whole number is the default. */
export function clampWidgetSize(id:DashboardWidgetId,w:unknown,h:unknown):DashboardWidgetSize{
 const rule=dashboardWidgetSizes[id];
 return {w:Math.min(dashboardColumns,Math.max(rule.minW,whole(w)?w:rule.w)),h:Math.min(dashboardMaxRows,Math.max(rule.minH,whole(h)?h:rule.h))};
}
const widget=(id:DashboardWidgetId):DashboardWidget=>({id,w:dashboardWidgetSizes[id].w,h:dashboardWidgetSizes[id].h});

/** The layout Nodiverna ships with: what needs attention first, then updates, security and hardware at a glance. */
export const builtInDashboardLayout:DashboardLayout=(['alarms','offline','updates','alarm-week','jobs','disk-space','defender','encryption','certificates','os-support','restart','crashes'] as const).map(widget);
/** The five tiles of the first Dashboard, in their built-in order: a stored layout of that format names them with a shown flag. */
export const formerDashboardTileIds=['alarms','offline','updates','jobs','alarm-week'] as const;

/**
 * A layout of a request body: an array of at most one entry per widget, each with exactly the keys id, w and h, a
 * known id that did not occur before, and a whole-number size inside the widget's range. Anything else is null.
 */
export function parseDashboardLayout(value:unknown):DashboardLayout|null{
 if(!Array.isArray(value)||value.length>dashboardWidgetIds.length)return null;
 const seen=new Set<string>(),layout:DashboardWidget[]=[];
 for(const entry of value){
  if(!entry||typeof entry!=='object'||Array.isArray(entry))return null;
  const keys=Object.keys(entry).sort(),{id,w,h}=entry as {id?:unknown;w?:unknown;h?:unknown};
  if(keys.length!==3||keys[0]!=='h'||keys[1]!=='id'||keys[2]!=='w'||!isDashboardWidgetId(id)||seen.has(id)||!whole(w)||!whole(h))return null;
  const fit=clampWidgetSize(id,w,h);
  if(fit.w!==w||fit.h!==h)return null;
  seen.add(id);layout.push({id,w,h});
 }
 return layout;
}

/** A stored layout of the first Dashboard ({id, shown} per tile): the shown tiles in their order with their default sizes; a tile the array does not name is appended, as that Dashboard read it. */
function formerDashboardLayout(value:readonly unknown[]):DashboardLayout{
 const seen=new Set<string>(),layout:DashboardWidget[]=[];
 for(const entry of value){
  if(!entry||typeof entry!=='object')continue;
  const {id,shown}=entry as {id?:unknown;shown?:unknown};
  if(typeof id!=='string'||!(formerDashboardTileIds as readonly string[]).includes(id)||seen.has(id))continue;
  seen.add(id);if(shown!==false)layout.push(widget(id as DashboardWidgetId));
 }
 for(const id of formerDashboardTileIds)if(!seen.has(id))layout.push(widget(id));
 return layout;
}

/** The version of the stored form: 2 is the widget list. The first Dashboard stored a bare array and had no version. */
export const dashboardLayoutVersion=2;
/** The text a layout is stored as: {"version":2,"widgets":[...]}. An object, so an empty board never reads as a layout of the first Dashboard. */
export const dashboardLayoutText=(layout:DashboardLayout):string=>JSON.stringify({version:dashboardLayoutVersion,widgets:layout.map(({id,w,h})=>({id,w,h}))});

/**
 * A stored layout, {version, widgets}: unknown widgets, repeats and non-objects are dropped, and a size outside the
 * widget's range is brought into it. A bare array is a layout of the first Dashboard and is read as such (migration
 * 0046 rewrites those rows; this keeps a row that it could not read usable). Unreadable JSON, and anything but
 * those two forms, is null. A widget is never added to a stored layout: the catalog offers it.
 */
export function storedDashboardLayout(text:string|null|undefined):DashboardLayout|null{
 if(typeof text!=='string')return null;
 let value:unknown;try{value=JSON.parse(text);}catch{return null;}
 if(Array.isArray(value))return formerDashboardLayout(value);
 const widgets=value&&typeof value==='object'?(value as {widgets?:unknown}).widgets:null;
 if(!Array.isArray(widgets))return null;
 const seen=new Set<DashboardWidgetId>(),layout:DashboardWidget[]=[];
 for(const entry of widgets){
  if(!entry||typeof entry!=='object')continue;
  const {id,w,h}=entry as {id?:unknown;w?:unknown;h?:unknown};
  if(!isDashboardWidgetId(id)||seen.has(id))continue;
  seen.add(id);layout.push({id,...clampWidgetSize(id,w,h)});
 }
 return layout;
}

/** The layout an account sees: its own, else the default. */
export const effectiveDashboardLayout=(own:DashboardLayout|null|undefined,fallback:DashboardLayout):DashboardLayout=>own??fallback;
export const sameDashboardLayout=(a:DashboardLayout|null|undefined,b:DashboardLayout|null|undefined):boolean=>
 a===b||(!!a&&!!b&&a.length===b.length&&a.every((item,index)=>item.id===b[index].id&&item.w===b[index].w&&item.h===b[index].h));
/** True when both preferences hold the same own layout (or none) and the same default layout. */
export const sameDashboardPreference=(a:DashboardPreference|null|undefined,b:DashboardPreference|null|undefined):boolean=>
 !!a&&!!b&&(a.own===null?b.own===null:sameDashboardLayout(a.own,b.own))&&sameDashboardLayout(a.default,b.default);
/** The layout with the widget at the place toIndex (brought into the list); the same layout when it is there already or not on the board. */
export function moveDashboardWidget(layout:DashboardLayout,id:DashboardWidgetId,toIndex:number):DashboardLayout{
 const from=layout.findIndex(item=>item.id===id),to=Math.min(layout.length-1,Math.max(0,Math.trunc(toIndex)));
 if(from<0||from===to||!Number.isFinite(toIndex))return layout;
 const next=[...layout],[moved]=next.splice(from,1);
 next.splice(to,0,moved);
 return next;
}
/** The layout with the widget in the size nearest to w by h that it may have; the same layout when its size stays. */
export function resizeDashboardWidget(layout:DashboardLayout,id:DashboardWidgetId,w:number,h:number):DashboardLayout{
 const current=layout.find(item=>item.id===id),fit=clampWidgetSize(id,Math.round(w),Math.round(h));
 if(!current||current.w===fit.w&&current.h===fit.h)return layout;
 return layout.map(item=>item.id===id?{id,...fit}:item);
}
/** The layout with the widget appended in its default size; the same layout when it is on the board already. */
export const addDashboardWidget=(layout:DashboardLayout,id:DashboardWidgetId):DashboardLayout=>layout.some(item=>item.id===id)?layout:[...layout,widget(id)];
/** The layout without the widget; the same layout when it is not on the board. */
export const removeDashboardWidget=(layout:DashboardLayout,id:DashboardWidgetId):DashboardLayout=>layout.some(item=>item.id===id)?layout.filter(item=>item.id!==id):layout;
