import {devicePermissionGuard,principal,viewerWriteGuard,type Permission,type SqlGuard} from './access';
import type {Viewer} from '../../types';
import {dbNow,sql,type Sql} from '../db';

// Internal generated SQL; one bound principal supplies every nested expression.
// These predicates are attached to the committing statement, after any remote
// calls, crypto or validation that can give a revocation time to complete.
export function featureWriteGuard(v:Viewer,guard:SqlGuard):SqlGuard{return sql`(${guard}) AND (${viewerWriteGuard(v)})`;}
export function featureDeviceGuard(v:Viewer,serverId:string,permissions:Permission[]){
 const rights=[...new Set(permissions)].map(permission=>devicePermissionGuard(sql`feature_actor.server_id`,sql`feature_actor.principal`,permission));
 if(!rights.length)throw new Error('A feature authorization requires a permission');
 return featureWriteGuard(v,sql`EXISTS (SELECT 1 FROM (SELECT ${principal(v)}::text AS principal,${serverId}::text AS server_id) feature_actor WHERE ${sql.join(rights.map(right=>sql`(${right})`),sql` AND `)})`);
}
export function featureTargetsGuard(v:Viewer,serverIds:string[],permissions:Permission[]){
 const rights=[...new Set(permissions)].map(permission=>devicePermissionGuard(sql`feature_target.value`,sql`feature_actor.principal`,permission));
 if(!rights.length||!serverIds.length)throw new Error('A target authorization requires a permission and targets');
 return featureWriteGuard(v,sql`EXISTS (SELECT 1 FROM (SELECT ${principal(v)}::text AS principal) feature_actor WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(${JSON.stringify(serverIds)}::jsonb) feature_target WHERE NOT (${sql.join(rights.map(right=>sql`(${right})`),sql` AND `)})))`);
}

// Interactive channels belong to the exact password/MFA session pair, not just
// a proof row that might survive a failed cleanup after primary logout/reset.
// An account from Microsoft Entra ID has no password; the bound mfa_hash below
// is its only path (docs/entra-id.md).
export function primaryMfaSessionGuard(principalExpression:Sql,mfaHashExpression:Sql,time:number):SqlGuard{
 return sql`EXISTS (SELECT 1 FROM local_auth_sessions interactive_primary JOIN local_users interactive_user ON interactive_user.id=interactive_primary.user_id AND interactive_user.auth_version=interactive_primary.auth_version WHERE interactive_user.auth_principal=${principalExpression} AND interactive_user.status='active' AND ((interactive_user.identity_source='local' AND interactive_user.password_hash IS NOT NULL) OR interactive_user.identity_source='entra') AND interactive_user.must_reset=0 AND interactive_primary.mfa_hash=${mfaHashExpression} AND interactive_primary.expires_at>${time} AND interactive_primary.expires_at>${dbNow})`;
}

