// The hash route of the customer view (lib/console-route.ts): #devices/customer/<id>[/<tab>[/<sub>]] with the
// tabs a customer has (Monitoring with its own alert rules; no tags, permissions or general
// settings), its Ungrouped scope
// #devices/customer/<id>/ungrouped[/…], and the old customer links.
import assert from 'node:assert/strict';
import '../support/register.mjs';

const {parseConsoleRoute,consoleRouteHash,startHash}=await import('../../lib/console-route.ts');
let checks=0;

// Parse.
assert.deepEqual(parseConsoleRoute('#devices/customer/cA'),{view:'devices',customerId:'cA',tab:'devices'});
assert.deepEqual(parseConsoleRoute('#devices/customer/cA/history'),{view:'devices',customerId:'cA',tab:'jobs'});
assert.deepEqual(parseConsoleRoute('#devices/customer/cA/history/access'),{view:'devices',customerId:'cA',tab:'access'});
assert.deepEqual(parseConsoleRoute('#devices/customer/cA/alarms/list'),{view:'devices',customerId:'cA',tab:'alarms'},'the alarms list of a customer');
assert.deepEqual(parseConsoleRoute('#devices/customer/cA/alarms'),{view:'devices',customerId:'cA',tab:'problems'},'the alarms by device of a customer');
assert.deepEqual(parseConsoleRoute('#devices/customer/cA/configuration/permissions'),{view:'devices',customerId:'cA',tab:'devices'},'a customer has no permissions tab');
assert.deepEqual(parseConsoleRoute('#devices/customer/cA/configuration/general'),{view:'devices',customerId:'cA',tab:'devices'});
assert.deepEqual(parseConsoleRoute('#devices/customer/cA/configuration/tags'),{view:'devices',customerId:'cA',tab:'devices'});
assert.deepEqual(parseConsoleRoute('#devices/customer/cA/configuration'),{view:'devices',customerId:'cA',tab:'notifications'},'the old bare Configuration of a customer is its notification rules');
assert.deepEqual(parseConsoleRoute('#devices/customer/cA/monitoring'),{view:'devices',customerId:'cA',tab:'problems'},'Monitoring › By device of a customer');
assert.deepEqual(parseConsoleRoute('#devices/customer/cA/monitoring/list'),{view:'devices',customerId:'cA',tab:'alarms'},'Monitoring › By alarm of a customer');
assert.deepEqual(parseConsoleRoute('#devices/customer/cA/monitoring/alert-rules'),{view:'devices',customerId:'cA',tab:'alerts'},'Monitoring › Alert rules of a customer (its own level)');
assert.deepEqual(parseConsoleRoute('#devices/customer/cA/monitoring/notification-rules'),{view:'devices',customerId:'cA',tab:'notifications'});
checks+=4;
assert.deepEqual(parseConsoleRoute('#devices/customer/a%2Fb%20c'),{view:'devices',customerId:'a/b c',tab:'devices'},'the id is decoded');
assert.deepEqual(parseConsoleRoute('#devices/customer/%E0'),{view:'devices'},'a malformed encoding');
assert.deepEqual(parseConsoleRoute('#devices/customer'),{view:'devices',tab:'devices'},'no id');
assert.deepEqual(parseConsoleRoute('#devices/customer/'),{view:'devices',tab:'devices'},'an empty id');
checks+=13;

// Hash.
assert.equal(consoleRouteHash({view:'devices',customerId:'cA',tab:'devices'}),'#devices/customer/cA');
assert.equal(consoleRouteHash({view:'devices',customerId:'cA',tab:'jobs'}),'#devices/customer/cA/history');
assert.equal(consoleRouteHash({view:'devices',customerId:'cA',tab:'access'}),'#devices/customer/cA/history/access');
assert.equal(consoleRouteHash({view:'devices',customerId:'cA',tab:'notifications'}),'#devices/customer/cA/monitoring/notification-rules','always named on a customer');
assert.equal(consoleRouteHash({view:'devices',customerId:'cA',tab:'problems'}),'#devices/customer/cA/monitoring');checks++;
assert.equal(consoleRouteHash({view:'devices',customerId:'cA',tab:'permissions'}),'#devices/customer/cA','no suffix for tabs a customer never has');
assert.equal(consoleRouteHash({view:'devices',customerId:'cA',tab:'settings'}),'#devices/customer/cA');
assert.equal(consoleRouteHash({view:'devices',customerId:'cA',tab:'alerts'}),'#devices/customer/cA/monitoring/alert-rules','the All devices alert rules of a customer');
assert.equal(consoleRouteHash({view:'devices',customerId:'a/b c'}),'#devices/customer/a%2Fb%20c');
assert.equal(consoleRouteHash({view:'devices',customerId:'cA',groupId:'g1',tab:'jobs'}),'#devices/customer/cA/history','customerId wins over groupId');
assert.equal(consoleRouteHash({view:'devices',customerId:'',groupId:'g1'}),'#devices/group/g1','an empty customerId is no customer');
checks+=10;

// The Ungrouped scope of a customer: the Ungrouped tab set under #devices/customer/<id>/ungrouped.
assert.deepEqual(parseConsoleRoute('#devices/customer/cA/ungrouped'),{view:'devices',customerId:'cA',groupId:'unassigned',tab:'devices'});
assert.deepEqual(parseConsoleRoute('#devices/customer/cA/ungrouped/inventory/drivers'),{view:'devices',customerId:'cA',groupId:'unassigned',tab:'drivers'});
assert.deepEqual(parseConsoleRoute('#devices/customer/cA/ungrouped/configuration/notification-rules'),{view:'devices',customerId:'cA',groupId:'unassigned',tab:'devices'},'no configuration on an Ungrouped scope');
assert.deepEqual(parseConsoleRoute('#devices/customer/cA/ungrouped/monitoring/notification-rules'),{view:'devices',customerId:'cA',groupId:'unassigned',tab:'devices'},'no rules on an Ungrouped scope');
assert.deepEqual(parseConsoleRoute('#devices/customer/cA/ungrouped/monitoring'),{view:'devices',customerId:'cA',groupId:'unassigned',tab:'problems'});
checks+=2;
assert.equal(consoleRouteHash({view:'devices',customerId:'cA',groupId:'unassigned',tab:'access'}),'#devices/customer/cA/ungrouped/history/access');
checks+=4;

// The health signal tabs are on the customer view, on All devices, on groups and on both Ungrouped scopes.
for(const [tab,sub] of [['software'],['extensions','extensions'],['os-support','os-support'],['encryption','encryption'],['drivers','drivers'],['reliability','reliability'],['certificates','certificates'],['autostart','autostart'],['protection','defender']]){
 const suffix='/inventory'+(sub?'/'+sub:'');
 for(const [prefix,fields] of [['#devices/customer/cA',{customerId:'cA'}],['#devices/group/g1',{groupId:'g1'}],['#devices',{}],['#devices/ungrouped',{groupId:'unassigned'}],['#devices/customer/cA/ungrouped',{customerId:'cA',groupId:'unassigned'}]]){
  assert.deepEqual(parseConsoleRoute(prefix+suffix),{view:'devices',...fields,tab},prefix+suffix);
  assert.equal(consoleRouteHash({view:'devices',...fields,tab}),prefix+suffix);
  checks+=2;
 }
}
assert.deepEqual(parseConsoleRoute('#devices/group/g1/bitlocker'),{view:'devices',groupId:'g1',tab:'devices'},'an unknown group tab falls back to devices');assert.deepEqual(parseConsoleRoute('#devices/customer/cA/bitlocker'),{view:'devices',customerId:'cA',tab:'devices'});checks+=2;
assert.deepEqual(parseConsoleRoute('#devices/inventory/bitlocker'),{view:'devices',tab:'software'},'an unknown inventory report is the default report');checks++;
// The removed Server roles subtab has no redirect: it is the Inventory default on every scope type.
for(const prefix of ['#devices','#devices/group/g1','#devices/customer/cA','#devices/ungrouped','#devices/customer/cA/ungrouped']){assert.equal(parseConsoleRoute(prefix+'/inventory/server-roles').tab,'software',prefix+'/inventory/server-roles');checks++;}

// The old customer links canonicalize.
for(const [old,hash] of [['#devices/customer/cA/problems','#devices/customer/cA/monitoring'],['#devices/customer/cA/jobs','#devices/customer/cA/history'],['#devices/customer/cA/access','#devices/customer/cA/history/access'],['#devices/customer/cA/alerts','#devices/customer/cA/monitoring/alert-rules'],['#devices/customer/cA/notifications','#devices/customer/cA/monitoring/notification-rules'],['#devices/customer/cA/software','#devices/customer/cA/inventory'],
 ['#devices/customer/cA/alarms','#devices/customer/cA/monitoring'],['#devices/customer/cA/alarms/list','#devices/customer/cA/monitoring/list'],['#devices/customer/cA/configuration','#devices/customer/cA/monitoring/notification-rules'],['#devices/customer/cA/configuration/notification-rules','#devices/customer/cA/monitoring/notification-rules'],
 ['#devices/customer/cA/ungrouped/alarms/list','#devices/customer/cA/ungrouped/monitoring/list'],['#devices/customer/cA/ungrouped/configuration','#devices/customer/cA/ungrouped']]){
 assert.equal(consoleRouteHash(parseConsoleRoute(old)),hash,old);checks++;
}
// The start page applies only without a hash; a customer link wins.
assert.equal(startHash('#devices/customer/cA','problems'),'#devices/customer/cA');assert.equal(startHash('','problems'),'#devices/monitoring');assert.equal(startHash('','other'),'');checks+=3;

// Round trip.
for(const hash of ['#devices/customer/cA','#devices/customer/cA/history','#devices/customer/cA/history/access','#devices/customer/a%2Fb%20c','#devices/customer/00000000-0000-4000-8000-000000000100','#devices/customer/cA/ungrouped','#devices/customer/cA/ungrouped/monitoring/list',
 '#devices/customer/cA/monitoring','#devices/customer/cA/monitoring/list','#devices/customer/cA/monitoring/alert-rules','#devices/customer/cA/monitoring/notification-rules','#devices/customer/cA/ungrouped/monitoring']){
 assert.equal(consoleRouteHash(parseConsoleRoute(hash)),hash,hash);checks++;
}
assert.equal(consoleRouteHash({view:'devices',groupId:'all',tab:'devices'}),'#devices');checks++;

console.log(`${checks} customer route checks passed.`);
