// Desired-State assignments carry the last result and the compliance verdict:
// five nullable columns with CHECK constraints in the baseline schema. The
// upgrade backfill from older schemas is gone with the single baseline.
import assert from 'node:assert/strict';
import {sql} from '../../runtime/database.mjs';
import {insertRow,sourceDatabase} from '../support/source-database.mjs';

const columns=['last_job_id','last_result_state','last_result_at','last_compliant','last_compliant_at'];
const d=await sourceDatabase();
let checks=0;const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
try{
 const info=Object.fromEntries((await d.query(sql`SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='desired_assignments'`)).map(row=>[row.column_name,[row.data_type,row.is_nullable,row.column_default]]));
 for(const [name,type] of [['last_job_id','text'],['last_result_state','text'],['last_result_at','bigint'],['last_compliant','bigint'],['last_compliant_at','bigint']])check(info[name],[type,'YES',null],name+' is a nullable '+type+' without default');
 check(info.last_checked_at,['bigint','YES',null],'last_checked_at is a nullable bigint without default');
 check(await d.query(sql`SELECT conname FROM pg_constraint WHERE conrelid='desired_assignments'::regclass AND contype='f'`),[],'no foreign key, jobs get deleted by retention');

 const at=1_700_000_000_000;
 for(const id of ['s-a','s-c'])await insertRow(d,'servers',{id,name:id,token_hash:'fixture-'+id,created_at:at});
 await insertRow(d,'desired_assignments',{id:'a',server_id:'s-a',version_id:'v1',assigned_by:'private:tester',assigned_at:at,last_checked_at:at+123,last_job_id:'job-a3',last_result_state:'failed',last_result_at:at+310,last_compliant:0,last_compliant_at:at+205});
 await insertRow(d,'desired_assignments',{id:'c',server_id:'s-c',version_id:'v1',assigned_by:'private:tester',assigned_at:at,interval_seconds:900});
 const row=id=>d.one(sql`SELECT ${sql.join(columns.map(name=>sql.ident(name)))},last_checked_at FROM desired_assignments WHERE id=${id}`);
 const stored={last_job_id:'job-a3',last_result_state:'failed',last_result_at:at+310,last_compliant:0,last_compliant_at:at+205,last_checked_at:at+123};
 check(await row('a'),stored,'a full result with a verdict is stored');
 check(await row('c'),{last_job_id:null,last_result_state:null,last_result_at:null,last_compliant:null,last_compliant_at:null,last_checked_at:null},'a new assignment starts without a result');

 // CHECK constraints reject inconsistent rows on insert and update.
 const reject=async(statement,label)=>{await assert.rejects(d.exec(statement),error=>error.code==='23514',label);checks++;};
 await reject(sql`UPDATE desired_assignments SET last_result_state='done' WHERE id='a'`,'unknown result state');
 await reject(sql`UPDATE desired_assignments SET last_compliant=2 WHERE id='a'`,'verdict outside 0/1');
 await reject(sql`UPDATE desired_assignments SET last_compliant=1,last_compliant_at=NULL WHERE id='c'`,'verdict without its time');
 await reject(sql`UPDATE desired_assignments SET last_compliant=NULL WHERE id='a'`,'time without its verdict');
 await reject(sql`UPDATE desired_assignments SET last_result_state='succeeded',last_result_at=1 WHERE id='c'`,'result state without job id');
 await reject(sql`UPDATE desired_assignments SET last_job_id=NULL WHERE id='a'`,'result time without job id');
 await reject(sql`INSERT INTO desired_assignments(id,server_id,version_id,assigned_by,assigned_at,last_job_id,last_result_state) VALUES('y','s-y','v1','p',1,'job','failed')`,'insert without result time');
 await reject(sql`INSERT INTO desired_assignments(id,server_id,version_id,assigned_by,assigned_at,last_compliant_at) VALUES('z','s-z','v1','p',1,5)`,'insert with a verdict time only');
 check(await row('a'),stored,'rejected writes leave the row unchanged');
 await d.exec(sql`UPDATE desired_assignments SET last_job_id='j',last_result_state='succeeded',last_result_at=1,last_compliant=1,last_compliant_at=1 WHERE id='c'`);
 await d.exec(sql`UPDATE desired_assignments SET ${sql.join(columns.map(name=>sql`${sql.ident(name)}=NULL`))} WHERE id='c'`);checks++;
 console.log(`PASS ${checks} desired-state status checks: five nullable columns with CHECKs, no foreign key to jobs, consistent writes accepted and inconsistent writes rejected.`);
}finally{await d.close();}
