// The read helper environmentRetentionView (runtime/maintenance.mjs) of the page
// Settings → Data retention: for unset, empty, valid and invalid
// SOFTWARE_CHANGE_RETENTION_DAYS and ALERT_RETENTION_DAYS it gives the same days
// as resolveRetention({env}), its source, and null with envInvalid where
// resolveRetention throws.
import assert from 'node:assert/strict';
import {defaultAlertRetentionDays,defaultSoftwareRetentionDays,environmentRetentionView,resolveRetention} from '../../runtime/maintenance.mjs';

let checks=0;
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks++;};
const variables={softwareDays:'SOFTWARE_CHANGE_RETENTION_DAYS',alertDays:'ALERT_RETENTION_DAYS'};
const resolved=(env,key)=>{try{return resolveRetention({env})[key];}catch{return null;}};

for(const [key,variable] of Object.entries(variables)){
 const fallback=key==='softwareDays'?defaultSoftwareRetentionDays:defaultAlertRetentionDays;
 const cases=[
  ['unset',{},{days:fallback,source:'default',envInvalid:false}],
  ['empty',{[variable]:''},{days:fallback,source:'default',envInvalid:false}],
  ['1',{[variable]:'1'},{days:1,source:'env',envInvalid:false}],
  ['3650',{[variable]:'3650'},{days:3650,source:'env',envInvalid:false}],
  ['45',{[variable]:'45'},{days:45,source:'env',envInvalid:false}],
  ['0',{[variable]:'0'},{days:null,source:'env',envInvalid:true}],
  ['3651',{[variable]:'3651'},{days:null,source:'env',envInvalid:true}],
  ['1.5',{[variable]:'1.5'},{days:null,source:'env',envInvalid:true}],
  ['abc',{[variable]:'abc'},{days:null,source:'env',envInvalid:true}],
  [' 30',{[variable]:' 30'},{days:null,source:'env',envInvalid:true}],
 ];
 for(const [label,env,expected] of cases){
  const view=environmentRetentionView(env)[key];
  check(view,expected,`${variable} ${label}`);
  check(view.days,resolved(env,key),`${variable} ${label}: the same days as resolveRetention (null where it throws)`);
 }
}
// The other variable does not leak: an invalid alarm value leaves the software value valid.
check(environmentRetentionView({ALERT_RETENTION_DAYS:'x',SOFTWARE_CHANGE_RETENTION_DAYS:'200'}),{softwareDays:{days:200,source:'env',envInvalid:false},alertDays:{days:null,source:'env',envInvalid:true}},'each variable on its own');
check(environmentRetentionView(undefined),{softwareDays:{days:365,source:'default',envInvalid:false},alertDays:{days:90,source:'default',envInvalid:false}},'no environment: the defaults');
console.log(`PASS ${checks} environment retention checks: unset, empty, valid and invalid software change and alarm retention match resolveRetention.`);
