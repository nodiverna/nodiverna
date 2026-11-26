import type {Viewer} from '../types';
import {dashboardLayoutText,storedDashboardLayout,type DashboardLayout} from '../dashboard-layout';
import {HttpError,now} from './context';
import {db,sql} from './db';

// The display preferences that follow an account to every browser
// (docs/branding.md, "Console background"): today only whether the console
// shows the portal background, and the account's own Dashboard layout
// (docs/dashboard.md). All SQL of account_preferences is here. An
// account reads and writes only its own row (viewer.userId); a missing row
// means the defaults. A personal display preference has no audit row and no
// MFA step-up (lib/step-up.ts).

export type AccountPreferences={consoleBackground:boolean};
export const defaultAccountPreferences:AccountPreferences={consoleBackground:true};

const ownId=(viewer:Viewer)=>{if(!viewer.userId)throw new HttpError('apiError.auth.loginRequired');return viewer.userId;};

/** The preferences of the viewer; the defaults without a row. */
export async function accountPreferences(viewer:Viewer):Promise<AccountPreferences>{
 if(!viewer.userId)return {...defaultAccountPreferences};
 const row=await db().one<{console_background:boolean}>(sql`SELECT console_background FROM account_preferences WHERE user_id=${viewer.userId}`);
 return {consoleBackground:row?row.console_background!==false:defaultAccountPreferences.consoleBackground};
}

/** Reads the body of PUT /api/account/preferences: exactly {consoleBackground:boolean}, else apiError.request.invalid. */
export function preferencesInput(input:Record<string,unknown>):AccountPreferences{
 const keys=Object.keys(input);
 if(keys.length!==1||typeof input.consoleBackground!=='boolean')throw new HttpError('apiError.request.invalid');
 return {consoleBackground:input.consoleBackground};
}

/** Upserts the row of the viewer and answers the stored preferences. */
export async function saveAccountPreferences(viewer:Viewer,next:AccountPreferences):Promise<AccountPreferences>{
 const userId=ownId(viewer);
 await db().exec(sql`INSERT INTO account_preferences(user_id,console_background,updated_at) VALUES (${userId},${next.consoleBackground},${now()}::bigint)
  ON CONFLICT (user_id) DO UPDATE SET console_background=excluded.console_background,updated_at=excluded.updated_at`);
 return accountPreferences(viewer);
}

/** The viewer's own Dashboard layout (lib/dashboard-layout.ts, the lenient reader); null without one: the account follows the default layout. */
export async function accountDashboardLayout(viewer:Viewer):Promise<DashboardLayout|null>{
 if(!viewer.userId)return null;
 const row=await db().one<{dashboard_layout:string|null}>(sql`SELECT dashboard_layout FROM account_preferences WHERE user_id=${viewer.userId}`);
 return storedDashboardLayout(row?.dashboard_layout);
}

/** Stores the viewer's own Dashboard layout, or clears it with null. The console background of the row stays. */
export async function saveAccountDashboardLayout(viewer:Viewer,layout:DashboardLayout|null):Promise<void>{
 const userId=ownId(viewer);
 await db().exec(sql`INSERT INTO account_preferences(user_id,dashboard_layout,updated_at) VALUES (${userId},${layout?dashboardLayoutText(layout):null}::text,${now()}::bigint)
  ON CONFLICT (user_id) DO UPDATE SET dashboard_layout=excluded.dashboard_layout,updated_at=excluded.updated_at`);
}
