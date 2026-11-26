import {dashboardAuditActions} from '../audit-actions';
import {builtInDashboardLayout,dashboardLayoutText,parseDashboardLayout,sameDashboardLayout,storedDashboardLayout,type DashboardLayout,type DashboardPreference} from '../dashboard-layout';
import type {Viewer} from '../types';
import {accountDashboardLayout,saveAccountDashboardLayout} from './account-preferences';
import {auditAfterChange} from './audit';
import {HttpError,now} from './context';
import {db,sql} from './db';
import {alarmWeek,type AlarmWeek} from './devices/alerts';
import {allowedDeviceIds,principal} from './identity/access';
import {can,viewerCanSql} from './identity/policy/can';
import {commitWithAudit} from './security-commit';

// The Dashboard (docs/dashboard.md): the layout an account sees and the data
// of its heatmap. All SQL of dashboard_settings, the Owner's default layout,
// is here; the account's own layout is a column of account_preferences
// (account-preferences.ts) and the alarm counts come from the alerts module.
// An account changes only its own layout: a personal display setting without
// an audit row or an MFA step-up. Only a global Owner changes the default
// layout; the write and its audit row commit in one batch behind the live
// Owner right, without an MFA step-up (lib/step-up.ts: a widget layout cannot run
// code, open access or weaken security).

/** The Owner's default layout; the built-in layout without a stored one. */
export async function dashboardDefaultLayout():Promise<DashboardLayout>{
 const row=await db().one<{default_layout:string}>(sql`SELECT default_layout FROM dashboard_settings WHERE id=1`);
 return storedDashboardLayout(row?.default_layout)??builtInDashboardLayout;
}

/** What GET /api/console carries as preferences.dashboard. A viewer without an account has no stored layout to follow: the built-in one, without a query (as accountPreferences). */
export async function dashboardPreference(viewer:Viewer):Promise<DashboardPreference>{
 if(!viewer.userId)return {own:null,default:builtInDashboardLayout};
 const [own,fallback]=await Promise.all([accountDashboardLayout(viewer),dashboardDefaultLayout()]);
 return {own,default:fallback};
}

/** Reads the body of both layout routes: exactly {layout}, a full layout or null; else apiError.request.invalid. */
export function dashboardLayoutInput(input:Record<string,unknown>):DashboardLayout|null{
 const keys=Object.keys(input);
 if(keys.length!==1||keys[0]!=='layout')throw new HttpError('apiError.request.invalid');
 if(input.layout===null)return null;
 const layout=parseDashboardLayout(input.layout);
 if(!layout)throw new HttpError('apiError.request.invalid');
 return layout;
}

/** PUT /api/account/dashboard: the viewer's own layout, null to follow the default again. */
export async function saveOwnDashboardLayout(viewer:Viewer,layout:DashboardLayout|null):Promise<DashboardPreference>{
 await saveAccountDashboardLayout(viewer,layout);
 return dashboardPreference(viewer);
}

/** Only a global Owner changes the default layout. fresh reads the right again after a refused write. */
export async function requireDashboardOwner(viewer:Viewer,fresh=false){if(!await can(viewer,'instance.owner',{fresh}))throw new HttpError('apiError.settings.ownerOnly');}

/**
 * PUT /api/dashboard/default: the default layout, null to go back to the built-in one. One audit row
 * (dashboard.default.set or dashboard.default.remove, target "layout") commits with the write; the same value again
 * writes nothing.
 */
export async function saveDefaultDashboardLayout(viewer:Viewer,layout:DashboardLayout|null):Promise<DashboardPreference>{
 await requireDashboardOwner(viewer);
 const row=await db().one<{default_layout:string}>(sql`SELECT default_layout FROM dashboard_settings WHERE id=1`);
 const stored=row?storedDashboardLayout(row.default_layout):null;
 if(layout?row&&sameDashboardLayout(stored,layout):!row)return dashboardPreference(viewer);
 const owner=viewerCanSql(viewer,'instance.owner');
 const statement=layout
  ?sql`INSERT INTO dashboard_settings(id,default_layout,updated_at,updated_by) SELECT 1,${dashboardLayoutText(layout)},${now()}::bigint,${principal(viewer)} WHERE (${owner})
    ON CONFLICT (id) DO UPDATE SET default_layout=excluded.default_layout,updated_at=excluded.updated_at,updated_by=excluded.updated_by`
  :sql`DELETE FROM dashboard_settings WHERE id=1 AND (${owner})`;
 const {results:[changed]}=await commitWithAudit([statement],
  {audit:{actor:viewer.label,action:layout?dashboardAuditActions.defaultSet:dashboardAuditActions.defaultRemove,target:'layout',customerId:null},guard:auditAfterChange,at:1});
 if(!changed.rowCount)await requireDashboardOwner(viewer,true);
 return dashboardPreference(viewer);
}

/** GET /api/dashboard: the hourly alarm counts of the devices the viewer may see. */
export async function dashboardData(viewer:Viewer):Promise<{alarmWeek:AlarmWeek}>{
 return {alarmWeek:await alarmWeek(JSON.stringify(await allowedDeviceIds(viewer)),now())};
}
