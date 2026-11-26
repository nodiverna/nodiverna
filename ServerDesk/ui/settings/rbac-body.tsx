'use client';
// The body states of the access views (Accounts, User groups, Roles and the Permissions view outside sample devices), in
// one place so the four views say the same thing in the same state (nodiverna-ui §5): a 401/403 shows Unavailable; before
// the first data the kit FirstLoad (table Skeleton, slow hint and retry after 15 s), then LoadFailed after a failure or
// Unavailable when the server answered without data; with data the content, and LoadFailed above it while a reload
// failed and the older data still shows.
import type {ReactNode} from 'react';
import type {Translate} from '@/ui/base/locale';
import {LoadFailed,Unavailable} from '@/ui/kit/kit';
import {FirstLoad} from '@/ui/kit/analysis-tab';
import type {RbacView} from '@/ui/settings/rbac-data';
import type {RbacData} from '@/ui/settings/rbac-model';

/** The body of an access view by its load state; content renders the loaded data. A plain function, so a view's element tree holds the states directly. */
export function rbacBody(rbac:Pick<RbacView,'data'|'loading'|'error'|'denied'|'load'>,t:Translate,content:(data:RbacData)=>ReactNode):ReactNode{
 const retry=()=>void rbac.load(),denied=<Unavailable reason="right">{t('rbac.needRole')}</Unavailable>;
 if(rbac.denied)return denied;
 if(!rbac.data)return rbac.loading?<FirstLoad label={t('rbac.loading')} onRetry={retry}/>:rbac.error?<LoadFailed text={t('rbac.loadFailed')} onRetry={retry}/>:denied;
 return <>
  {rbac.error&&<LoadFailed text={t('rbac.loadFailed')} loading={rbac.loading} onRetry={retry}/>}
  {content(rbac.data)}
 </>;
}
