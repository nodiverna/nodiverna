'use client';
// The focal point of the default Monitoring subtab (nodiverna-ui §8): a KPI row that answers "what is watched here, who
// is told" above the alarm table, which answers "what fired". The scope By device view and the device Monitoring › Alarms
// show it. The counts come from ui/devices/monitoring/monitoring-summary-model.ts over the same GETs the Alert rules and Notification rules
// subtabs use, so the row and the subtabs never disagree. A tile whose request is pending or failed has no value; KpiRow
// leaves it out and renders nothing with fewer than two tiles, so a failure adds no second error here.
import {useEffect,useState} from 'react';
import {BellRing,Send} from 'lucide-react';
import {defaultAlertRuleView,type AlertRuleView} from '@/lib/alert-rules';
import type {NotificationRulesView} from '@/lib/server/notifications/notification-rules';
import {monitoringSummary,type MonitoringSummary} from '@/ui/devices/monitoring/monitoring-summary-model';
import {api} from '@/ui/base/api';
import {Kpi,KpiRow} from '@/ui/kit/kit';
import type {AlertRulesScope} from '@/ui/devices/monitoring/alert-rules';
import type {NotificationRulesScope} from '@/ui/devices/monitoring/notification-rules';
import {useT} from '@/ui/base/locale';

type Open={onOpenAlertRules:()=>void;onOpenNotificationRules:()=>void};

/**
 * The two tiles: "Alert rules on" with the rules changed here, and "Notification rules" with their channels. No
 * notification rule is the one warning ("Nobody gets notified."); sample devices have none by design, so their tile is
 * neutral and says so. Each tile opens its subtab.
 */
export function MonitoringKpis({summary,demo,onOpenAlertRules,onOpenNotificationRules}:{summary:MonitoringSummary;demo:boolean}&Open){
 const t=useT();
 const changed=summary.alertRulesChanged??0,rules=demo?0:summary.notificationRules;
 return <KpiRow label={t('monitoringTab.kpi.label')} entranceId="monitoring-kpis">
  <Kpi label={t('monitoringTab.kpi.alertRules.label')} icon={BellRing} value={summary.alertRulesOn}
   detail={changed?t('monitoringTab.kpi.alertRules.changed',{count:changed}):t('monitoringTab.kpi.alertRules.unchanged')} onSelect={onOpenAlertRules}/>
  <Kpi label={t('monitoringTab.kpi.notifications.label')} icon={Send} value={rules} tone={demo?'neutral':rules===0?'warning':'accent'}
   detail={demo?t('monitoringTab.kpi.notifications.demo'):rules===0?t('monitoringTab.kpi.notifications.none'):t('monitoringTab.kpi.notifications.channels',{count:summary.channels??0})} onSelect={onOpenNotificationRules}/>
 </KpiRow>;
}

const alertKey=(scope:AlertRulesScope)=>`${scope.type}:${scope.type==='global'?'*':scope.id}`;
const notificationKey=(scope:NotificationRulesScope)=>scope.type==='all'?'all':`${scope.type}:${scope.id}`;

/**
 * Loads the two views of a scope and shows MonitoringKpis. alertScope is the scope of GET /api/alert-rules (a customer
 * passes its own customer scope), notificationScope the one of GET /api/notifications/rules; null leaves that tile without a value.
 * Sample devices load nothing: the alert rules are the defaults, the notification tile is the demo tile.
 */
export default function MonitoringSummaryRow({alertScope,notificationScope,demo,...open}:{alertScope:AlertRulesScope|null;notificationScope:NotificationRulesScope|null;demo:boolean}&Open){
 const alertId=alertScope?alertKey(alertScope):'',notificationId=notificationScope?notificationKey(notificationScope):'';
 const [alerts,setAlerts]=useState<{key:string;view:AlertRuleView}|null>(null);
 const [notifications,setNotifications]=useState<{key:string;view:NotificationRulesView}|null>(null);
 useEffect(()=>{
  if(demo||!alertId)return;
  let current=true;
  const at=alertId.indexOf(':');
  api<AlertRuleView>(`/api/alert-rules?${new URLSearchParams({scopeType:alertId.slice(0,at),scopeId:alertId.slice(at+1)})}`).then(view=>{if(current)setAlerts({key:alertId,view});},()=>{});
  return()=>{current=false;};
 },[alertId,demo]);
 useEffect(()=>{
  if(demo||!notificationId)return;
  let current=true;
  api<NotificationRulesView>(`/api/notifications/rules?${new URLSearchParams({scope:notificationId})}`).then(view=>{if(current)setNotifications({key:notificationId,view});},()=>{});
  return()=>{current=false;};
 },[notificationId,demo]);
 if(!alertScope&&!notificationScope)return null;
 const alertView=!alertScope?null:demo?defaultAlertRuleView({type:alertScope.type,id:alertScope.id,name:''}):alerts?.key===alertId?alerts.view:null;
 const notificationView=!notificationScope?null:demo?{direct:[],inherited:[]}:notifications?.key===notificationId?notifications.view:null;
 return <MonitoringKpis summary={monitoringSummary(alertView,notificationView)} demo={demo} {...open}/>;
}
