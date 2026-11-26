// The UI text of the alert rules (lib/alert-rules.ts): thresholds with their
// unit, the one-sentence description from the effective values and the short
// summary of the inherited value. Every sentence is one catalog entry with
// parameters; nothing is joined from fragments here.
import {alarmSettingsApply,alertRule,type AlertLevel,type AlertRule,type AlertRuleId,type AlertRuleSettings,type LimitRule,type ThresholdRule} from './alert-rules';
import {formatNumber} from './i18n/format';
import {defaultLocale,type Locale} from './i18n/locale';
import {translate,type MessageKey} from './i18n/translate';

const levelKeys:Record<AlertLevel,MessageKey>={info:'alertRules.level.info',warning:'alertRules.level.warning',critical:'alertRules.level.critical'};
const unitKeys={percent:'alertRules.unit.percent',ms:'alertRules.unit.ms',perProcessor:'alertRules.unit.perProcessor'} as const satisfies Record<string,MessageKey>;
/** The field suffix of a threshold input. */
export const alertUnitSuffix:Record<ThresholdRule['unit'],MessageKey>={percent:'alertRules.suffix.percent',ms:'alertRules.suffix.ms',days:'alertRules.suffix.days',perProcessor:'alertRules.suffix.perProcessor',minutes:'alertRules.suffix.minutes',count:'alertRules.suffix.count',index:'alertRules.suffix.index'};
export const alertLevelLabel=(level:AlertLevel,locale:Locale=defaultLocale)=>translate(locale,levelKeys[level]);
export const alertRuleName=(id:AlertRuleId,locale:Locale=defaultLocale)=>translate(locale,alertRule(id).name);
/** A threshold with its unit: "80 %", "50 ms", "7 days", "2 threads per processor", "15 minutes"; count and index as plain numbers ("3", "5"). */
export function formatAlertThreshold(rule:ThresholdRule|LimitRule,value:number,locale:Locale=defaultLocale,dative=false):string{
 if(rule.unit==='days')return translate(locale,dative?'alertRules.unit.daysDative':'alertRules.unit.days',{count:value});
 if(rule.unit==='minutes')return translate(locale,'alertRules.unit.minutes',{count:value});
 if(rule.unit==='count'||rule.unit==='index')return formatNumber(locale,value);
 return translate(locale,unitKeys[rule.unit],{value:formatNumber(locale,value)});
}
/** The one sentence that says when the rule fires with these settings. */
export function alertRuleDescription(rule:AlertRule,settings:AlertRuleSettings,locale:Locale=defaultLocale):string{
 if(!settings.enabled)return translate(locale,'alertRules.disabled');
 if(rule.kind==='boolean')return translate(locale,rule.description[settings.level??rule.defaults.level]);
 if(rule.kind==='limit')return settings.warning===null?translate(locale,'alertRules.disabled'):translate(locale,rule.description[settings.level??rule.defaults.level],{threshold:formatAlertThreshold(rule,settings.warning,locale)});
 const dative=rule.dative??[];
 const warning=settings.warning===null?null:formatAlertThreshold(rule,settings.warning,locale,dative.includes('warning')),critical=settings.critical===null?null:formatAlertThreshold(rule,settings.critical,locale,dative.includes('critical'));
 // A critical step of 0 days left means "once it has ended" (os-support-end).
 const ended=settings.critical===0;
 if(warning!==null&&critical!==null)return ended&&rule.description.bothEnded?translate(locale,rule.description.bothEnded,{warning}):translate(locale,rule.description.both,{warning,critical});
 if(warning!==null)return translate(locale,rule.description.warningOnly,{warning});
 if(critical!==null)return ended&&rule.description.criticalOnlyEnded?translate(locale,rule.description.criticalOnlyEnded):translate(locale,rule.description.criticalOnly,{critical});
 return translate(locale,'alertRules.disabled');
}
/** The short form for "Inherited: <summary> from <origin>". */
export function alertSettingsSummary(rule:AlertRule,settings:AlertRuleSettings,locale:Locale=defaultLocale):string{
 if(!settings.enabled)return translate(locale,'alertRules.summary.off');
 if(rule.kind==='boolean')return alertLevelLabel(settings.level??rule.defaults.level,locale);
 if(rule.kind==='limit')return settings.warning===null?translate(locale,'alertRules.summary.off'):translate(locale,'alertRules.summary.limit',{threshold:formatAlertThreshold(rule,settings.warning,locale),level:alertLevelLabel(settings.level??rule.defaults.level,locale)});
 const warning=settings.warning===null?null:formatAlertThreshold(rule,settings.warning,locale),critical=settings.critical===null?null:formatAlertThreshold(rule,settings.critical,locale);
 if(warning!==null&&critical!==null)return translate(locale,'alertRules.summary.thresholds',{warning,critical});
 if(warning!==null)return translate(locale,'alertRules.summary.warningOnly',{warning});
 if(critical!==null)return translate(locale,'alertRules.summary.criticalOnly',{critical});
 return translate(locale,'alertRules.summary.off');
}
/**
 * The short form of the minimum duration and the recovery margin for the column
 * "Alarm", or null for a rule without them (boolean rules, device-offline and
 * the age and date rules).
 */
export function alertAlarmSummary(rule:AlertRule,settings:AlertRuleSettings,locale:Locale=defaultLocale):string|null{
 if(!alarmSettingsApply(rule))return null;
 const minutes=settings.durationMinutes??0,margin=settings.recovery??0;
 const duration=translate(locale,'alertRules.unit.minutes',{count:minutes}),recovery=formatAlertThreshold(rule,margin,locale);
 if(minutes>0&&margin>0)return translate(locale,'alertRules.alarm.both',{duration,recovery});
 if(minutes>0)return translate(locale,'alertRules.alarm.durationOnly',{duration});
 if(margin>0)return translate(locale,'alertRules.alarm.recoveryOnly',{recovery});
 return translate(locale,'alertRules.alarm.immediate');
}
/** The summary of an inherited value with its minimum duration and recovery margin, for "Inherited: <summary> from <origin>". */
export function alertInheritedSummary(rule:AlertRule,settings:AlertRuleSettings,locale:Locale=defaultLocale):string{
 const summary=alertSettingsSummary(rule,settings,locale),alarm=settings.enabled?alertAlarmSummary(rule,settings,locale):null;
 return alarm===null?summary:translate(locale,'alertRules.summary.withAlarm',{summary,alarm});
}
