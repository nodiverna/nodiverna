// The one place that decides whether an actor is the instance Owner. Server code
// asks can()/requireCan() for pre-checks and attaches canSql()/viewerCanSql() to
// the committing statement. Lint (no-restricted-syntax in eslint.config.mjs)
// keeps role==='admin', hasGlobalPermission(…,'*') and globalOwnerGuard out of
// lib/, app/api/ and route handlers.
//
// The client asks isOwner(viewer) in ui/base/access-capabilities.ts ('*' in the
// viewer's permissions); it only shapes the interface, the server decides here.
//
// Known follow-up work:
// - globalOwnerSubject in the customer boundary and remainingOwnerGuard
//   (lib/server/identity/access.ts) keep their own SQL.
// - Named instance rights, a shared rights catalogue and an AuthContext do not
//   exist yet.
//
// Imported bindings are used only inside functions, so the module stays safe in
// an import cycle with lib/server/identity/local-auth.ts and lib/server/identity/access.ts.
import {globalOwnerGuard,principal,type SqlGuard} from '../access';
import {featureWriteGuard} from '../feature-authorization';
import {HttpError} from '../../context';
import type {ApiErrorKey} from '../../../errors/api-error-keys';
import type {Viewer} from '../../../types';
import {db,sql,type Sql} from '../../db';

export type InstanceRight='instance.owner';

/** SQL condition: the principal named by `actorExpression` holds the right now. */
export function canSql(actorExpression:Sql,right:InstanceRight):SqlGuard{
 if(right!=='instance.owner')throw new Error('Unknown instance right');
 return globalOwnerGuard(actorExpression);
}

/** Commit guard: the viewer holds the right and its session/auth-version stamp is still valid. */
export function viewerCanSql(v:Viewer,right:InstanceRight):SqlGuard{
 const guard=canSql(sql`policy_actor.principal`,right);
 return featureWriteGuard(v,sql`EXISTS (SELECT 1 FROM (SELECT ${principal(v)}::text AS principal) policy_actor WHERE ${guard})`);
}

// Per request: one answer per Viewer object and right. Nothing is stored on the
// viewer itself, and a spread copy is a new object that asks again.
const answers=new WeakMap<Viewer,Map<InstanceRight,Promise<boolean>>>();

/** Live check, cached per Viewer object; `fresh` always asks the database and replaces the cached answer. */
export function can(v:Viewer,right:InstanceRight,options:{fresh?:boolean}={}):Promise<boolean>{
 let byRight=answers.get(v);if(!byRight){byRight=new Map();answers.set(v,byRight);}
 const cached=byRight.get(right);if(cached&&!options.fresh)return cached;
 const guard=canSql(sql`${principal(v)}`,right);
 const answer=(async()=>!!await db().one(sql`SELECT 1 AS allowed WHERE ${guard}`))();
 const entries=byRight;entries.set(right,answer);
 // A failed query is not an answer: the next call asks again.
 answer.catch(()=>{if(entries.get(right)===answer)entries.delete(right);});
 return answer;
}

/** Pre-check: 403 with the message key unless can() is true. */
export async function requireCan(v:Viewer,right:InstanceRight,message:ApiErrorKey='apiError.policy.permissionMissing'):Promise<void>{
 if(await can(v,right))return;
 throw new HttpError(message);
}
