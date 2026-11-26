import {usageDataAuditActions} from '../audit-actions';
import {config,HttpError,now} from './context';
import {defaultLocale} from '../i18n/locale';
import {translate} from '../i18n/translate';
import {principal} from './identity/access';
import {can,viewerCanSql} from './identity/policy/can';
import {commitWithAudit} from './security-commit';
import {licenseServerState,usageDataEnabled,usagePayload} from '../../runtime/usage-report.mjs';
import type {Viewer} from '../types';
import {db,sql} from './db';

// Usage data for product improvement (docs/usage-data.md). Only global Owners
// read or change the decision; the daily maintenance sends the report
// (runtime/usage-report.mjs). Whether the function is on decides only
// usageDataEnabled() there; the view carries it as `enabled` for the UI.
export const usageDataOwnerOnlyMessage=translate(defaultLocale,'apiError.settings.ownerOnly');
export const usageDataInvalidMessage=translate(defaultLocale,'apiError.settings.usageInvalid');
export const usageDataConflictMessage=translate(defaultLocale,'apiError.settings.conflict');
export const usageDataUnavailableMessage=translate(defaultLocale,'apiError.settings.usageUnavailable');
export const usageDataUnknownActionMessage=translate(defaultLocale,'apiError.request.unknownAction');
export const usageDataAudit={target:'Daten zur Produktverbesserung',...usageDataAuditActions} as const;

export type UsagePayload={schema:2;instanceId:string;version:string;deviceCount:number};
export type UsageDataView={enabled:boolean;consent:boolean|null;decidedAt:number|null;revision:number;server:'none'|'invalid'|'configured';lastAttemptAt:number|null;lastSuccessAt:number|null;lastError:string|null;payload:UsagePayload};
type UsageRow={consent:number|null;decided_at:number|null;revision:number;last_attempt_at:number|null;last_success_at:number|null;last_error:string|null};

const usageOn=()=>usageDataEnabled({LICENSE_SERVER_URL:config('LICENSE_SERVER_URL')});
const readRow=()=>db().one<UsageRow>(sql`SELECT consent,decided_at,revision,last_attempt_at,last_success_at,last_error FROM usage_data WHERE id=1`);
// decided_by and the server URL stay on the server.
async function view():Promise<UsageDataView>{
 const row=await readRow();if(!row)throw new Error('usage_data is missing');
 return {enabled:usageOn(),consent:row.consent===null?null:row.consent===1,decidedAt:row.decided_at,revision:row.revision,server:licenseServerState(config('LICENSE_SERVER_URL')) as UsageDataView['server'],
  lastAttemptAt:row.last_attempt_at,lastSuccessAt:row.last_success_at,lastError:row.last_error,payload:await usagePayload(db()) as UsagePayload};
}
// The re-check after a refused commit asks the database again (fresh): a demoted Owner gets 403, not a conflict.
async function requireOwner(viewer:Viewer,fresh=false){if(!await can(viewer,'instance.owner',{fresh}))throw new HttpError('apiError.settings.ownerOnly');}

/** GET /api/usage-data: the decision, the report state and the current payload. Owners only. */
export async function usageDataStatus(viewer:Viewer):Promise<UsageDataView>{await requireOwner(viewer);return view();}

/**
 * Sets the decision. No MFA step-up: withdrawing must be as easy as agreeing,
 * and the setting grants no rights. The Owner right and the revision are
 * checked again in the committing batch, together with the audit row. While usage
 * data is off, an Owner gets 409 and nothing is written (validation and the
 * Owner check come first).
 */
export async function setUsageConsent(viewer:Viewer,enabled:unknown,revision:unknown):Promise<UsageDataView>{
 if(typeof enabled!=='boolean'||typeof revision!=='number'||!Number.isSafeInteger(revision)||revision<0)throw new HttpError('apiError.settings.usageInvalid');
 await requireOwner(viewer);
 if(!usageOn())throw new HttpError('apiError.settings.usageUnavailable');
 const value=enabled?1:0,current=await readRow();
 if(current?.consent===value)return view();
 const owner=viewerCanSql(viewer,'instance.owner'),guard=sql`EXISTS (SELECT 1 FROM usage_data consent_row WHERE consent_row.id=1 AND consent_row.revision=${revision}) AND (${owner})`;
 // The audit row runs first with the update's own condition, so it exists
 // exactly when the update happens.
 // The row is locked first, so parallel changes queue instead of retrying.
 const {results:[,...results]}=await commitWithAudit([
  sql`SELECT id FROM usage_data WHERE id=1 FOR UPDATE`,
  sql`UPDATE usage_data SET consent=${value},decided_at=${now()},decided_by=${principal(viewer)},revision=revision+1 WHERE id=1 AND revision=${revision} AND (${owner})`,
 ],{audit:{actor:viewer.label,action:enabled?usageDataAudit.enabled:usageDataAudit.disabled,target:usageDataAudit.target},guard,at:1});
 if(results[0].rowCount)return view();
 await requireOwner(viewer,true);
 throw new HttpError('apiError.settings.conflict');
}
