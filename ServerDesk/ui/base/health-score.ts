// The health of a device from its open alarms (docs/alert-rules.md, "Health and
// the Problems tab"), without React and without server imports: the state and
// the score of the Health column, the rows of the scope tab "Problems" and the
// device area of an alarm. The server already limits Server.alerts to the
// viewer's customer boundary, so everything here runs in the browser.
import type {AlertIssueParams,AlertLevel,AlertRuleId} from '@/lib/alert-rules';
import type {OpenAlert,Server} from '@/lib/types';
import {defaultLocale,type Locale} from '@/lib/i18n/locale';
import {translate,type MessageKey} from '@/lib/i18n/translate';
import type {DeviceSection} from '@/lib/console-route';

/** Points that each open alarm subtracts from 100, by its current level. The only place that holds the weights. */
export const healthWeights:Readonly<Record<AlertLevel,number>>={critical:40,warning:15,info:5};

export type HealthState='good'|'warning'|'critical'|'unknown';
export type DeviceHealth={state:HealthState;score:number|null;counts:Record<AlertLevel,number>};
type HealthDevice=Pick<Server,'alerts'|'lastSeen'>;

/**
 * The health of a device: every open alarm counts once at its current level,
 * acknowledged and muted ones too. The score is 100 minus the weights, at least
 * 0. The state follows the worst level; info alarms lower the score but keep
 * the state good. A device without a Heartbeat and without alarms has no data.
 */
export function deviceHealth(server:HealthDevice):DeviceHealth{
 const counts={critical:0,warning:0,info:0};
 for(const alert of server.alerts??[])counts[alert.level]++;
 if(server.lastSeen===null&&!counts.critical&&!counts.warning&&!counts.info)return {state:'unknown',score:null,counts};
 const score=Math.max(0,100-healthWeights.critical*counts.critical-healthWeights.warning*counts.warning-healthWeights.info*counts.info);
 return {state:counts.critical?'critical':counts.warning?'warning':'good',score,counts};
}

/**
 * The health a device list shows (the fleet table and the device cards): as deviceHealth, but a device
 * without an inventory and without alarms has no data yet, so it does not read as "Good".
 */
export function listHealth(server:HealthDevice&{snapshot?:unknown}):DeviceHealth{
 const health=deviceHealth(server);
 return !server.snapshot&&!server.alerts?.length?{state:'unknown',score:null,counts:health.counts}:health;
}

export const healthStateKeys:Record<HealthState,MessageKey>={good:'health.state.good',warning:'health.state.warning',critical:'health.state.critical',unknown:'health.state.unknown'};
/** Critical first, unknown last: the order of the Health sort and the Problems rows. */
export const healthStateRank:Record<HealthState,number>={critical:0,warning:1,good:2,unknown:3};

/** The state label and the tooltip that explains the score with the weights and the device's counts. */
export function healthText(health:DeviceHealth,locale:Locale=defaultLocale):{label:string;tooltip:string}{
 const label=translate(locale,healthStateKeys[health.state]);
 if(health.state==='unknown'||health.score===null)return {label,tooltip:translate(locale,'health.tooltipUnknown')};
 return {label,tooltip:translate(locale,'health.tooltip',{score:health.score,critical:healthWeights.critical,warning:healthWeights.warning,info:healthWeights.info,criticalCount:health.counts.critical,warningCount:health.counts.warning,infoCount:health.counts.info})};
}

export type AlarmTarget={section:DeviceSection;detail?:string};
/** The device area of each rule: where the console shows the signal the rule reads. */
const alarmTargets:Record<AlertRuleId,AlarmTarget>={
 cpu:{section:'diagnostics',detail:'processes'},memory:{section:'diagnostics',detail:'processes'},'processor-queue':{section:'diagnostics',detail:'processes'},
 pagefile:{section:'hardware',detail:'memory'},
 'disk-free':{section:'management',detail:'storage'},'disk-latency':{section:'management',detail:'storage'},'disk-health-failed':{section:'management',detail:'storage'},'ssd-wear':{section:'management',detail:'storage'},'disk-errors':{section:'management',detail:'storage'},
 'bitlocker-system-unencrypted':{section:'management',detail:'storage'},'bitlocker-suspended':{section:'management',detail:'storage'},'bitlocker-no-recovery-password':{section:'management',detail:'storage'},
 'reboot-pending':{section:'management',detail:'updates'},'updates-pending':{section:'management',detail:'updates'},
 'device-problem':{section:'software',detail:'drivers'},'driver-unsigned':{section:'software',detail:'drivers'},
 'crash-recent':{section:'diagnostics',detail:'events'},'stability-low':{section:'diagnostics',detail:'events'},'app-crash-repeated':{section:'diagnostics',detail:'events'},
 'cert-expiring':{section:'software',detail:'certificates'},'cert-expiring-no-key':{section:'software',detail:'certificates'},
 'autostart-new':{section:'software',detail:'autostart'},'autostart-new-suspicious':{section:'software',detail:'autostart'},
 'threat-detected':{section:'management',detail:'defender'},'scan-age':{section:'management',detail:'defender'},'defender-off':{section:'management',detail:'defender'},'signatures-age':{section:'management',detail:'defender'},
 'battery-capacity':{section:'hardware',detail:'overview'},
 'dhcp-scope-full':{section:'extensions',detail:'dhcp'},'dhcp-service-stopped':{section:'extensions',detail:'dhcp'},'dns-service-stopped':{section:'extensions',detail:'dns'},
 'agent-stopped':{section:'overview'},'agent-removed':{section:'overview'},'agent-protection-changed':{section:'overview'},
 'firewall-off':{section:'overview'},'os-support-end':{section:'overview'},'os-support-unknown':{section:'overview'},'inventory-incomplete':{section:'overview'},'device-offline':{section:'overview'},
};
/**
 * The device area of an alarm, for the jump from the Problems tab. Every rule
 * has an area today; params and server are there for rules whose area depends
 * on the finding. An unknown rule opens the overview.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- params and server stay in the signature for rules whose area depends on the finding; no rule needs them today.
export function alarmTarget(ruleId:string,params?:AlertIssueParams,server?:Pick<Server,'snapshot'>):AlarmTarget{
 return Object.hasOwn(alarmTargets,ruleId)?{...alarmTargets[ruleId as AlertRuleId]}:{section:'overview'};
}

const levelRank:Record<AlertLevel,number>={critical:0,warning:1,info:2};
/** Critical → warning → info, then the oldest start first, then rule id and key. */
export function compareReasons(a:OpenAlert,b:OpenAlert):number{
 return levelRank[a.level]-levelRank[b.level]||a.startedAt-b.startedAt||a.ruleId.localeCompare(b.ruleId)||a.key.localeCompare(b.key);
}

type ProblemDevice=Pick<Server,'id'|'name'|'alerts'|'lastSeen'>;
export type ProblemRow<D extends ProblemDevice=ProblemDevice>={device:D;health:DeviceHealth;since:number;reasons:OpenAlert[]};
const collator=new Intl.Collator('en',{numeric:true});
/** Critical before warning, then the device open longest at its worst level, then the lower score, then name and id. */
export function compareProblemRows(a:ProblemRow,b:ProblemRow):number{
 return healthStateRank[a.health.state]-healthStateRank[b.health.state]||a.since-b.since||(a.health.score??0)-(b.health.score??0)||collator.compare(a.device.name,b.device.name)||a.device.id.localeCompare(b.device.id);
}
/**
 * The worklist of the Problems tab: one row per device with a warning or
 * critical alarm, with all its open alarms as reasons. `since` is the earliest
 * start among the alarms at the worst level. The rows do not depend on the
 * time, so there is no `now`: the tab formats the duration with its clock.
 */
export function problemRows<D extends ProblemDevice>(devices:readonly D[]):ProblemRow<D>[]{
 const rows:ProblemRow<D>[]=[];
 for(const device of devices){
  const health=deviceHealth(device);
  if(health.state!=='critical'&&health.state!=='warning')continue;
  const reasons=[...device.alerts??[]].sort(compareReasons);
  const since=Math.min(...reasons.filter(alert=>alert.level===health.state).map(alert=>alert.startedAt));
  rows.push({device,health,since,reasons});
 }
 return rows.sort(compareProblemRows);
}
export function problemCounts(rows:readonly ProblemRow[]):{all:number;critical:number;warning:number}{
 return {all:rows.length,critical:rows.filter(row=>row.health.state==='critical').length,warning:rows.filter(row=>row.health.state==='warning').length};
}
