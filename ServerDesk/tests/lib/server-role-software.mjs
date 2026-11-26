// Server roles on PostgreSQL (lib/server/extensions/server-role-software.ts with the catalog of lib/extensions.ts, docs/server-roles.md):
// consoleServerSoftware reads the server products of every device of the scope
// in one statement, only for devices in the scope, with an escaped prefix
// filter; devices without a match are absent. The console route calls it once.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {sourceDatabase,sourceLoader,insertRow} from '../support/source-database.mjs';
import {hookDatabase} from '../support/hooked-database.mjs';
import {sql} from '../../runtime/database.mjs';
import '../support/register.mjs';

const {normalizeSoftwareName,normalizeSoftwareVersion}=await import('../../lib/software-inventory.ts');
const {detectionSoftwarePrefixes,matchServerSoftware}=await import('../../lib/extensions.ts');
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const customerA='00000000-0000-4000-8000-000000000100';
const counted={on:false,statements:0};
const d=await sourceDatabase(),db=hookDatabase(d,{statement:()=>{if(counted.on)counted.statements++;}});
const load=sourceLoader();
const lib=load('lib/server/extensions/server-role-software.ts',{'../db':{db:()=>db,sql}});
const time=Date.now(),insert=(table,row)=>insertRow(d,table,row);
async function device(name){const id=crypto.randomUUID();await insert('servers',{id,name,token_hash:'fixture-'+id,created_at:time,last_seen:time,management:1,snapshot:null,customer_id:customerA});return id;}
let key=0;
const program=(serverId,name,version=null)=>insert('device_software',{server_id:serverId,key:`{K-${++key}}`,scope:'machine',architecture:'x64',name,normalized_name:normalizeSoftwareName(name,version),version,normalized_version:normalizeSoftwareVersion(version),publisher:null,install_date:null,first_seen:time,updated_at:time});

try{
 const sqlHost=await device('SRV-SQL'),veeamHost=await device('SRV-BACKUP'),plain=await device('SRV-PLAIN'),outside=await device('SRV-OUTSIDE');
 await program(sqlHost,'Microsoft SQL Server 2019 (64-bit)');
 await program(sqlHost,'SQL Server 2019 Database Engine Services','15.0.4375.4');
 await program(sqlHost,'SQL Server 2019 Common Files','15.0.4375.4');
 await program(sqlHost,'Microsoft SQL Server Management Studio - 20.2','20.2.30.0');
 await program(sqlHost,'Google Chrome','120.0.1');
 await program(veeamHost,'Veeam Agent for Microsoft Windows','6.1.2.134');
 await program(veeamHost,'Veeam Backup & Replication Console','12.1.0.2131');
 // A name with % and _ where the prefix has a space and a letter: the escaped pattern does not let it in.
 await program(plain,'Microsoft%SQL_Server 2019');
 await program(plain,'Veeam Backup & Replication Console','12.1.0.2131');
 await program(outside,'Microsoft SQL Server 2022 (64-bit)','16.0.4135.4');

 const scope=JSON.stringify([sqlHost,veeamHost,plain]);
 counted.on=true;
 const result=await lib.consoleServerSoftware(scope,db);
 counted.on=false;
 check(counted.statements,1,'one statement for all devices of the scope');
 check([...result.keys()].sort(),[sqlHost,veeamHost].sort(),'only devices with a match; the device outside the scope and the device without a match are absent');
 check(result.get(sqlHost),[{id:'sql-server',version:'15.0.4375.4',names:['Microsoft SQL Server 2019 (64-bit)','SQL Server 2019 Database Engine Services']}],'SQL Server with the highest version and the matched names only');
 check(result.get(veeamHost),[{id:'veeam-agent',version:'6.1.2.134',names:['Veeam Agent for Microsoft Windows']}],'Veeam Agent; the console is no product');
 check((await lib.consoleServerSoftware(JSON.stringify([outside]),db)).get(outside),[{id:'sql-server',version:'16.0.4135.4',names:['Microsoft SQL Server 2022 (64-bit)']}],'the other device in its own scope');
 check((await lib.consoleServerSoftware('[]',db)).size,0,'an empty scope gives an empty map');

 // The prefilter loses nothing: the exact patterns over every stored row give the same products.
 const all=async id=>(await d.query(sql`SELECT name,version,normalized_name,normalized_version FROM device_software WHERE server_id=${id}`)).map(row=>({name:row.name,version:row.version,normalizedName:row.normalized_name,normalizedVersion:row.normalized_version}));
 check([matchServerSoftware(await all(sqlHost)),matchServerSoftware(await all(veeamHost))],[result.get(sqlHost),result.get(veeamHost)],'the prefixes (detectionSoftwarePrefixes) cover every match of the patterns');
 check(detectionSoftwarePrefixes.length>0&&detectionSoftwarePrefixes.every(prefix=>prefix===prefix.toLowerCase()),true,'the prefixes of lib/extensions.ts are lower case');

 // The prefix pattern escapes LIKE wildcards.
 check(lib.prefixLikePattern('a_b%c\\'),'a\\_b\\%c\\\\%','backslash, _ and % are escaped');
 const like=async(value,prefix)=>(await d.query(sql`SELECT ${value} LIKE ${lib.prefixLikePattern(prefix)} AS hit`))[0].hit;
 check([await like('sql server 2019','sql server 20'),await like('sqlxserver 2019','sql_server 20'),await like('sql_server 2019','sql_server 20'),await like('sql server 2019','sql%')],[true,false,true,false],'an escaped _ or % matches only itself');
 const rows=await d.query(sql`SELECT normalized_name FROM device_software WHERE server_id=${plain} ORDER BY normalized_name`);
 check(rows.map(item=>item.normalized_name),['microsoft%sql_server 2019','veeam backup & replication console'],'the fixture names are stored as written');

 const route=fs.readFileSync('app/api/console/route.ts','utf8');
 check((route.match(/consoleServerSoftware\(/g)??[]).length,1,'the console route calls consoleServerSoftware exactly once');
 check(/serverSoftware:software/.test(fs.readFileSync('lib/server/devices/device-projection.ts','utf8'))&&route.includes('projectDevices('),true,'the console projection (lib/server/devices/device-projection.ts) sets serverSoftware on a device with a match');
 console.log(`PASS server role software (${checks} checks): one statement, scope only, highest version and matched names, absent devices, escaped prefixes, one call in the console route.`);
}finally{await d.close();}
