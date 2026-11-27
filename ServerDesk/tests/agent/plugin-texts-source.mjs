// Static checks of the plain-language result messages of the DHCP and DNS plugins (agent/plugins/dhcp and dns): the
// plugin versions that ship them (DHCP 1.1.2, DNS 1.0.5) in the csproj and Program.cs, their release notes (one fix,
// no feature, valid for validateReleaseChangelog), the seven messages that keep their text, and the placeholders of
// every message, which stay the same so that a portal that knows the old codes renders the new results. No build: the
// plugin self-tests run with --self-test in the Windows build.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {serverDeskRoot} from '../support/paths.mjs';
import {validateReleaseChangelog} from '../../scripts/release-changelog.mjs';
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const read=file=>readFileSync(path.join(serverDeskRoot,file),'utf8');

/** The Messages dictionary of a plugin Program.cs: code -> English template. */
const messages=program=>Object.fromEntries([...program.matchAll(/\["(PLUGIN_[A-Z_]+)"\] = "([^"]*)"/g)].map(match=>[match[1],match[2]]));
const placeholders=text=>[...text.matchAll(/\{([a-z]+)\}/gi)].map(match=>match[1]);

const plugins={
 dhcp:{project:'ServerDesk.Plugin.Dhcp.csproj',version:'1.1.2',
  placeholders:{PLUGIN_DHCP_READ_COMPLETED:['scopes','leases'],PLUGIN_DHCP_SERVICE_STOPPED:[],PLUGIN_DHCP_ACCESS_DENIED:[],PLUGIN_DHCP_NOT_INSTALLED:[],PLUGIN_DHCP_READ_FAILED:['error'],PLUGIN_DHCP_CHANGED:[],PLUGIN_DHCP_CHANGED_NOT_READ:[],PLUGIN_DHCP_INVALID_CHANGE:['field'],PLUGIN_DHCP_OBJECT_EXISTS:['object'],PLUGIN_DHCP_OBJECT_MISSING:['object'],PLUGIN_DHCP_IN_FAILOVER:['scope'],PLUGIN_DHCP_SECRET_MISSING:[],PLUGIN_DHCP_CHANGE_FAILED:['error']},
  unchanged:{
   PLUGIN_DHCP_READ_FAILED:'The DHCP server could not be read (error {error}). Try again.',
   PLUGIN_DHCP_CHANGED:'The DHCP server was changed.',
   PLUGIN_DHCP_CHANGE_FAILED:'The DHCP server refused the change (error {error}). Check the values and try again.',
  },
  changelog:{version:'1.1.2',features:[],fixes:['The messages of the DHCP extension say what happened and what to do next, for example where to start a stopped service.']}},
 dns:{project:'ServerDesk.Plugin.Dns.csproj',version:'1.0.5',
  placeholders:{PLUGIN_DNS_READ_COMPLETED:['zones'],PLUGIN_DNS_ZONE_READ_COMPLETED:['zone','records'],PLUGIN_DNS_SERVICE_STOPPED:[],PLUGIN_DNS_NOT_INSTALLED:[],PLUGIN_DNS_READ_FAILED:['error'],PLUGIN_DNS_ACCESS_DENIED:[],PLUGIN_DNS_CHANGED:[],PLUGIN_DNS_CHANGED_NOT_READ:[],PLUGIN_DNS_INVALID_CHANGE:['field'],PLUGIN_DNS_OBJECT_EXISTS:['object'],PLUGIN_DNS_OBJECT_MISSING:['object'],PLUGIN_DNS_NOT_DOMAIN_CONTROLLER:[],PLUGIN_DNS_CHANGE_FAILED:['error'],PLUGIN_DNS_CHANGE_FAILED_DETAIL:['error','detail']},
  unchanged:{
   PLUGIN_DNS_READ_FAILED:'The DNS server could not be read (error {error}). Try again.',
   PLUGIN_DNS_CHANGED:'The DNS server was changed.',
   PLUGIN_DNS_CHANGE_FAILED:'The DNS server refused the change (error {error}). Check the values and try again.',
   PLUGIN_DNS_CHANGE_FAILED_DETAIL:'The DNS server refused the change (error {error}). Windows reports: {detail} Check the values and try again.',
  },
  changelog:{version:'1.0.5',features:[],fixes:['The messages of the DNS extension say what happened and what to do next, for example where to start a stopped service.']}},
};

for(const [name,plugin] of Object.entries(plugins)){
 const dir=`agent/plugins/${name}`,program=read(`${dir}/Program.cs`),project=read(`${dir}/${plugin.project}`);
 // ---- Version ----
 check(/<Version>([^<]+)<\/Version>/.exec(project)?.[1],plugin.version,`${plugin.project}: version ${plugin.version}`);
 check(new RegExp(String.raw`Name = "${name}", BaseVersion = "([^"]+)", Version = BaseVersion \+ BuildVersion\.DevSuffix;`).exec(program)?.[1],plugin.version,`${name} Program.cs: BaseVersion ${plugin.version}`);
 // ---- Release notes ----
 const changelog=JSON.parse(read(`${dir}/changelogs/${plugin.version}.json`));
 check(changelog,plugin.changelog,`changelogs/${plugin.version}.json has the release note of the messages`);
 check(validateReleaseChangelog(changelog,plugin.version),{features:[],fixes:plugin.changelog.fixes},`changelogs/${plugin.version}.json passes the release-notes rules`);
 // ---- Messages ----
 const texts=messages(program);
 check(Object.keys(texts),Object.keys(plugin.placeholders),`${name}: the same codes in the same order`);
 for(const [code,expected] of Object.entries(plugin.placeholders))check(placeholders(texts[code]),expected,`${code}: the same placeholders`);
 for(const [code,text] of Object.entries(plugin.unchanged))check(texts[code],text,`${code} keeps its text`);
 check(Object.entries(texts).filter(([,text])=>/[“”]/.test(text)&&!/“Read again”/.test(text)).map(([code])=>code),[],`${name}: typographic quotes only around the button name`);
}

console.log(`PASS plugin texts source (${checks} checks): DHCP 1.1.2 and DNS 1.0.5 in the csproj and Program.cs, their release notes, the codes and placeholders of all 27 messages and the 7 messages that keep their text.`);
