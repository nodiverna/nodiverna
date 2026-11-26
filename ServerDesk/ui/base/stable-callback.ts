// A handler that keeps its identity across renders and always calls the latest function. The console hands its
// handlers to memoized views (FleetView, InventoryTree, rows); a new closure on every render would render them again.
import {useCallback,useLayoutEffect,useRef} from 'react';

/** A stable function that calls the latest `fn` (updated after each commit; call it from events and effects, not from a render). */
export function useStableCallback<Args extends unknown[],Result>(fn:(...args:Args)=>Result):(...args:Args)=>Result{
 const latest=useRef(fn);
 useLayoutEffect(()=>{latest.current=fn;});
 return useCallback((...args:Args)=>latest.current(...args),[]);
}
