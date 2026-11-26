'use client';
// The console background (docs/branding.md, "Console background"): the portal image an Owner chose on Settings ›
// Branding, strongly blurred behind the whole console, like a desktop wallpaper (ui/shell/console-backdrop.css). It
// shows while the portal has a console background, the account did not turn it off in My account (account_preferences,
// PUT /api/account/preferences), and the system asks for neither reduced transparency nor forced colors. Each region
// dims it with its own scrim; the server computes the scrims from the measured image (lib/backdrop.ts) and the console
// writes them as custom properties on .sdx. Content stays on its own opaque surfaces.
import {useSyncExternalStore,type CSSProperties} from 'react';
import {backdropScrimProperties} from '@/lib/backdrop';
import type {ConsoleBackgroundView,ConsoleBranding} from '@/lib/branding';
import {credentialFetch,readApiJson} from '@/ui/base/api';
import '@/ui/shell/console-backdrop.css';

/**
 * The background the console shows: the portal console background while the account's preference is on and the
 * system allows transparency (`allowed`, useBackdropAllowed), else null.
 */
export function consoleBackdrop(branding:Pick<ConsoleBranding,'consoleBackground'>|undefined,preference:boolean,allowed=true):ConsoleBackgroundView|null{
 return preference&&allowed?branding?.consoleBackground??null:null;
}

/** The query under which the console shows no background: reduced transparency or forced colors. */
export const backdropOffQuery='(prefers-reduced-transparency: reduce), (forced-colors: active)';
const subscribe=(change:()=>void)=>{
 const query=window.matchMedia(backdropOffQuery);
 query.addEventListener('change',change);
 return ()=>query.removeEventListener('change',change);
};
/**
 * Whether the system allows the background: false under reduced transparency or forced colors, and follows a change
 * of either setting at once. A browser that does not know a query treats it as not set.
 */
export function useBackdropAllowed():boolean{
 return useSyncExternalStore(subscribe,()=>!window.matchMedia(backdropOffQuery).matches,()=>false);
}

/** The scrim custom properties of .sdx (--sdx-scrim-<region>-<mode>), only while a background shows. */
export function consoleBackdropStyle(background:Pick<ConsoleBackgroundView,'scrim'>|null):CSSProperties|undefined{
 return background?backdropScrimProperties(background.scrim) as CSSProperties:undefined;
}

/**
 * The backdrop layer: the first child of .sdx-body, outside the navigator, the workspace and the dock, fixed to the
 * viewport behind the whole frame. A new image remounts (keyed by its URL) and fades in once; a data refresh with the
 * same image changes nothing.
 */
export function ConsoleBackdrop({background}:{background:Pick<ConsoleBackgroundView,'url'>|null}){
 if(!background)return null;
 return <div className="sdx-backdrop" aria-hidden="true">
  <img key={background.url} className="sdx-backdrop-image" src={background.url} alt="" aria-hidden="true" decoding="async" fetchPriority="low"/>
 </div>;
}

/** PUT /api/account/preferences: the account's own console background switch. Resolves with the stored value. */
export async function saveConsoleBackground(next:boolean):Promise<boolean>{
 const response=await credentialFetch('/api/account/preferences',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({consoleBackground:next}),cache:'no-store'});
 return (await readApiJson<{consoleBackground:boolean}>(response)).consoleBackground;
}
