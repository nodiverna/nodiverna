// Pure display-state regression checks. No Worker or Windows device is contacted.
import '../../support/register.mjs';
import '../../support/german-default.mjs';
import assert from 'node:assert/strict';
const {deviceConnection, deviceIssues, liveValue, diskSummary, registrationNote}=await import('../../../ui/base/ui-device.ts');
const {defaultAlertSettings, evaluateAlertRules}=await import('../../../lib/alert-rules.ts');

const now = 1_800_000_000_000;
const disk = (name, totalGb, freeGb) => ({name, label:name, totalGb, freeGb});
const snapshot = {
  hostname:'UI-TEST', os:'Microsoft Windows Server 2025 Datacenter', build:'26100',
  manufacturer:'Microsoft', model:'Virtual Machine', domain:'WORKGROUP', cores:4,
  memoryGb:16, cpu:12, memory:28, uptimeSeconds:3600, rebootPending:false,
  management:true, protocolVersion:3, agentVersion:'3.0.1', mode:'Management',
  agentCapabilities:['refresh'], disks:[disk('C:', 100, 70)], services:[],
  processes:[], events:[], networks:[], hotfixes:[], collectionErrors:[],
};
// The console route attaches the issues it evaluated (lib/alert-rules.ts); fixtures do the same with the defaults.
const withIssues = device => ({...device, issues:evaluateAlertRules(device, defaultAlertSettings(), now)});
const server = (changes = {}, inventory = {}) => withIssues({
  id:'00000000-0000-4000-8000-000000000002', name:'UI-TEST', createdAt:now - 3600000,
  lastSeen:now - 30000, revoked:0, management:1,
  snapshot:{...snapshot, ...inventory}, ...changes,
});

assert.equal(deviceConnection(server(), now).kind, 'online');
assert.equal(deviceConnection(server({lastSeen:now - 120001}), now).kind, 'offline');
assert.equal(deviceConnection(server({lastSeen:null, snapshot:null}), now).kind, 'waiting');
assert.equal(deviceConnection(server({lastSeen:now - 119999}), now).kind, 'online');
assert.equal(deviceConnection(server({lastSeen:now - 120000}), now).kind, 'offline',
  'at two minutes the UI no longer presents metrics as live');
for (const state of ['scheduled', 'queued']) {
  assert.equal(deviceConnection(server({maintenance:{state, version:'3.0.1', notBefore:now + 3600000}}), now).kind,
    'online', 'a future or queued agent update does not replace connection status');
}
const updating = server({maintenance:{state:'updating', version:'3.0.1', notBefore:now}});
assert.equal(deviceConnection(updating, now).kind, 'maintenance');

// A never-connected device shows whether its registration is still usable.
const waiting = registration => server({lastSeen:null, snapshot:null, ...(registration === undefined ? {} : {registration})});
assert.deepEqual(deviceConnection(waiting({expiresAt:now + 1}), now), {kind:'waiting', label:'Erste Meldung ausstehend'});
assert.deepEqual(deviceConnection(waiting({expiresAt:now}), now), {kind:'waiting', label:'Registrierung abgelaufen'},
  'a registration expiring at this instant is expired');
assert.deepEqual(deviceConnection(waiting({expiresAt:null}), now), {kind:'waiting', label:'Erste Meldung ausstehend'});
assert.deepEqual(deviceConnection(waiting(undefined), now), {kind:'waiting', label:'Erste Meldung ausstehend'});
const future = now + 3 * 86400000;
assert.equal(registrationNote(waiting({expiresAt:future}), now), 'Registrierung gültig bis ' + new Date(future).toLocaleString('de-DE'));
assert.equal(registrationNote(waiting({expiresAt:now - 1}), now), 'Registrierung abgelaufen');
assert.equal(registrationNote(waiting({expiresAt:null}), now), 'Registrierung ohne Ablauf');
assert.equal(registrationNote(server(), now), null, 'a connected device has no registration note');
assert.equal(liveValue(updating, 12, now), null, 'maintenance does not pretend to provide live metrics');

const troubled = server({}, {cpu:98, memory:97, rebootPending:true, disks:[disk('C:', 100, 4)]});
assert.equal(deviceConnection(troubled, now).kind, 'online',
  'a reachable device with technical warnings is still connected');
assert.ok(deviceIssues(troubled, now).length >= 3,
  'high resource use, limited free disk and pending reboot remain visible separately');
assert.ok(deviceIssues(troubled, now).every(issue =>
  issue.key && issue.title && issue.detail && ['critical', 'warning', 'info'].includes(issue.level)),
  'each warning has concrete display text and severity');
assert.equal(new Set(deviceIssues(troubled, now).map(issue => issue.key)).size,
  deviceIssues(troubled, now).length, 'issues have stable distinct keys');
assert.equal(deviceIssues(server({}, {rebootPending:false,rebootReasons:[],pendingFileOperationsCount:2}),now).length,0,
  'neutral boot-time cleanup does not raise a reboot or inventory warning');
assert.equal(deviceIssues(server({}, {rebootPending:true,rebootReasons:['windows-update','file-replacement'],pendingFileOperationsCount:2}),now).find(issue=>issue.key==='reboot').detail,
  'Windows Update · Dateiersetzung','confirmed reboot causes remain explicit even alongside cleanup');
assert.match(deviceIssues(server({}, {rebootPending:true}),now).find(issue=>issue.key==='reboot').detail,/Windows meldet/,
  'older agents without separate causes remain compatible');

assert.equal(liveValue(server(), 0, now), 0, 'a measured zero remains a valid measurement');
assert.equal(liveValue(server(), 12.5, now), 12.5);
for (const value of [null, undefined, NaN, Infinity, -Infinity, '12']) {
  assert.equal(liveValue(server(), value, now), null, 'missing or invalid values never become zero');
}
assert.equal(liveValue(server({lastSeen:now - 120001}), 12, now), null,
  'stale inventory is not shown as a current metric');
assert.equal(liveValue(server({lastSeen:null, snapshot:null}), 12, now), null,
  'a waiting device has no live measurement');

const staleTroubled = {...troubled, lastSeen:now - 120001};
assert.ok(deviceIssues(staleTroubled, now).every(issue => !['cpu','memory','latency','queue','pagefile'].includes(issue.key)),
  'old performance measurements do not create current resource warnings');
assert.ok(deviceIssues(staleTroubled, now).some(issue => issue.key === 'reboot'),
  'last-inventory reboot information remains available with its timestamp');
assert.ok(deviceIssues(staleTroubled, now).some(issue => issue.key.startsWith('disk-')),
  'last-inventory free space remains available');
assert.equal(deviceIssues(server({snapshot:null}), now).length, 0,
  'missing inventory cannot manufacture a healthy or warning measurement');

const storage = server({}, {disks:[disk('No media', 0, 0), disk('C:', 100, 20), disk('D:', 1000, 150)]});
assert.equal(diskSummary(storage)?.name, 'D:', 'free ratio selects the most constrained volume');
assert.equal(diskSummary(server({}, {disks:[]})), null);
assert.equal(diskSummary(server({}, {disks:[disk('No media', 0, 0)]})), null,
  'unknown capacity does not produce a false zero-percent-free disk');
assert.equal(diskSummary(server({snapshot:null})), null);

console.log('PASS: separate connectivity and health, two-minute freshness, missing metrics, genuine zeroes and worst-volume storage summary.');
