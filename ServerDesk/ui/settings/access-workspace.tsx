'use client';

import type {AuditEntry,Server,Viewer} from '@/lib/types';
import AccountsPage from '@/ui/settings/settings-accounts';
import UserGroupsPage from '@/ui/settings/settings-user-groups';
import RolesPage from '@/ui/settings/settings-roles';
import AuditLogPage from '@/ui/settings/audit-log';
import UsageDataPage from '@/ui/settings/usage-data-page';
import CustomersPanel from '@/ui/settings/customers-panel';
import BrandingPage from '@/ui/settings/branding-page';
import SessionSettingsPanel from '@/ui/settings/session-settings-panel';
import EntraSettingsPanel from '@/ui/settings/entra-settings-panel';
import MaintenancePanel from '@/ui/settings/maintenance-panel';
import NotificationsPanel from '@/ui/settings/notifications-panel';
import VulnerabilitiesPanel from '@/ui/settings/vulnerabilities-panel';
import AssistantSettingsPanel from '@/ui/settings/assistant-settings-panel';
import {canOpenAccessSection} from '@/ui/base/access-capabilities';
import type {SettingsSection} from '@/lib/console-route';
import {SettingsPage,Unavailable} from '@/ui/kit/kit';
import {useT} from '@/ui/base/locale';
import {frameHeader,type PageFrame} from '@/ui/shell/page-frame';

type Props={viewer:Viewer;servers?:Server[];demo:boolean;onRefresh:()=>Promise<void>|void;section:SettingsSection;entries?:AuditEntry[];auditLoading?:boolean;
 /** ConsoleData.multipleCustomers: the Audit log shows its Area column only then. */
 multipleCustomers?:boolean;
 /** "Assign role" from Accounts: the console opens All devices › Configuration › Permissions with this account (AccountsPage). */
 onAssignRole?:(userId:string)=>void;
 /** The console frame of the page (ui/shell/page-frame.ts): its header, the refresh count and the page tab; handed to the section. */
 frame?:PageFrame;
 /** The viewer's own console background preference: the Branding page notes when it is off. */
 consoleBackgroundOn?:boolean};

/**
 * The settings page of a settings section (the SettingsPage ids of #settings/<page> without the agent pages). Each section
 * component renders the page header of the frame once, at its top, in every state (ui/shell/page-frame.ts); AccessWorkspace
 * renders it only in its own no-permission branch, followed by one SettingsPage with the kit Unavailable notice.
 */
export default function AccessWorkspace({section,viewer,servers=[],demo,onRefresh,entries=[],auditLoading=false,multipleCustomers=false,onAssignRole,frame,consoleBackgroundOn=true}:Props){
 const t=useT();
 if(!canOpenAccessSection(viewer,section))return <>{frameHeader(frame)}<SettingsPage label={t('nav.settings.title')}><Unavailable reason="right">{t('access.noPermission')}</Unavailable></SettingsPage></>;
 switch(section){
  case 'sessions':return <SessionSettingsPanel viewer={viewer} frame={frame}/>;
  case 'entra':return <EntraSettingsPanel viewer={viewer} frame={frame}/>;
  case 'retention':return <MaintenancePanel viewer={viewer} frame={frame}/>;
  case 'notification-channels':return <NotificationsPanel viewer={viewer} frame={frame}/>;
  case 'vulnerabilities':return <VulnerabilitiesPanel viewer={viewer} frame={frame}/>;
  case 'assistant':return <AssistantSettingsPanel viewer={viewer} frame={frame}/>;
  case 'customers':return <CustomersPanel viewer={viewer} frame={frame}/>;
  case 'audit':return <AuditLogPage entries={entries} servers={servers} loading={auditLoading} multipleCustomers={multipleCustomers} frame={frame}/>;
  case 'usage-data':return <UsageDataPage frame={frame}/>;
  case 'branding':return <BrandingPage frame={frame} onChanged={onRefresh} consoleBackgroundOn={consoleBackgroundOn}/>;
  case 'accounts':return <AccountsPage key={section} viewer={viewer} demo={demo} onRefresh={onRefresh} onAssignRole={onAssignRole} frame={frame}/>;
  case 'user-groups':return <UserGroupsPage key={section} viewer={viewer} demo={demo} onRefresh={onRefresh} frame={frame}/>;
  case 'roles':return <RolesPage key={section} viewer={viewer} demo={demo} onRefresh={onRefresh} frame={frame}/>;
 }
}
