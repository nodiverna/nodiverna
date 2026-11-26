// What the console gives a page besides its data (nodiverna-ui §4 "Console page", "Page with tabs" and "Settings
// page"). The console builds one PageFrame per render for every Settings page, every Automation page and My account,
// and passes it as the prop `frame` (AccessWorkspace hands it on to its section component; the agent pages,
// AutomationWorkspace and AccountPanel get it directly).
//
// Header: the console renders no PageHeader for these pages. The page renders frame.header(primary) exactly once, at
// its top, in every state (first load, load error, no permission, demo, unavailable), with its one primary Btn or with
// nothing. frame.header builds the header from the page's nav node (ui/shell/nav-model.ts): the node label as the title, the
// node subtitle or hint as the subtitle (My account: the Entra subtitle for an Entra account), no crumbs, and the area
// crumb button of a navigator page. No flag or list says which page owns its header: the page always does.
//
// Refresh: frame.refresh counts the console refreshes (the top-bar refresh, the shortcut R, the palette action).
// useFrameRefresh(frame, load) runs the page's load GET again on each change, never on mount. The page keeps its loaded
// data visible while that GET runs (no skeleton on a refresh).
//
// Tab: frame.tab is the page's tab id from the route (automationPageTabs, settingsPageTabs in lib/console-route.ts), or
// the page's first tab when the link has none; '' for a page without tabs. frame.onTab(id) opens that tab with one
// history entry: the first tab writes no segment, an unknown id opens the first tab, and Back and Forward switch the tab.
// The tab bar reads its items from the page's tab nodes (pageTabNodes in ui/shell/nav-model.ts).
import {useEffect,useRef,type ReactNode} from 'react';

export type PageFrame={
 /** The page header with an optional page primary (one Btn). Call it once, at the top of the page, in every state. */
 header:(primary?:ReactNode)=>ReactNode;
 /** Counts the console refreshes while the console runs; a change asks the page to load again. */
 refresh:number;
 /** The tab id of the page: the route's tab or the page's first tab; '' for a page without tabs. */
 tab:string;
 /** Opens a tab of the page; the console writes the hash with one history entry. */
 onTab:(tab:string)=>void;
};

/** The page header of a frame, or nothing without a frame (a page rendered outside the console, as in the view tests). */
export const frameHeader=(frame:PageFrame|undefined,primary?:ReactNode):ReactNode=>frame?frame.header(primary):null;

/**
 * Runs `load` again whenever frame.refresh changes after the first render. Without a frame it does nothing. The
 * latest `load` runs, so a caller may pass a new function on every render.
 */
export function useFrameRefresh(frame:PageFrame|undefined,load:()=>unknown){
 useRefreshCount(frame?.refresh??0,load);
}
/**
 * Runs `load` again whenever `count` changes after the first render, never on mount. A view outside a frame (the
 * Permissions view of a scope or a device) takes the console's refresh count as a prop and reloads with it.
 */
export function useRefreshCount(count:number,load:()=>unknown){
 const seen=useRef(count),latest=useRef(load);
 useEffect(()=>{latest.current=load;});
 useEffect(()=>{
  if(seen.current===count)return;
  seen.current=count;
  void latest.current();
 },[count]);
}
