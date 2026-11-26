// The summary of a Monitoring tab (docs/alert-rules.md, docs/notifications.md): "what is watched here, who is told".
// Pure: it counts what the two GETs of the Monitoring subtabs return (GET /api/alert-rules and
// GET /api/notifications/rules), so the KPI row and the subtabs show the same server evaluation.
import type {AlertRuleView} from '@/lib/alert-rules';
import type {NotificationRulesView} from '@/lib/server/notifications/notification-rules';

export type MonitoringSummary={
 /** The rules that are on here (effective.enabled); null without an alert rule view. */
 alertRulesOn:number|null;
 /** The rules with a change on this scope (override); null without an alert rule view. */
 alertRulesChanged:number|null;
 /** The direct and inherited notification rules that can send: the rule and its channel are on; null without a notification rule view. */
 notificationRules:number|null;
 /** The distinct channels of those rules; null without a notification rule view. */
 channels:number|null;
};

/** Counts the summary of a Monitoring tab. Either view may be null (still loading, failed, or the scope has none): its fields are then null. */
export function monitoringSummary(alertView:Pick<AlertRuleView,'rules'>|null,notificationView:Pick<NotificationRulesView,'direct'|'inherited'>|null):MonitoringSummary{
 const sending=notificationView?[...notificationView.direct,...notificationView.inherited].filter(rule=>rule.enabled&&rule.channel.enabled):null;
 return {
  alertRulesOn:alertView?alertView.rules.filter(rule=>rule.effective.enabled).length:null,
  alertRulesChanged:alertView?alertView.rules.filter(rule=>rule.override!==null).length:null,
  notificationRules:sending?sending.length:null,
  channels:sending?new Set(sending.map(rule=>rule.channel.id)).size:null,
 };
}
