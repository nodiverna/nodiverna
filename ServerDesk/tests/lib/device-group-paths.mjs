// device_group_paths stores the device group ancestry and AFTER triggers keep
// it current; device_group_ancestors is a thin view over it. The oracle is a
// recursive query over device_groups, inlined here. Each test runs on its own
// migrated PostgreSQL test database.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sql} from '../../runtime/database.mjs';
import {sourceDatabase} from '../support/source-database.mjs';

const at=1_700_000_000_000;
const oracle=sql`WITH RECURSIVE ancestry(group_id,ancestor_id,depth) AS (
 SELECT id,id,0 FROM device_groups
 UNION ALL
 SELECT ancestry.group_id,g.parent_id,ancestry.depth+1
 FROM ancestry JOIN device_groups g ON g.id=ancestry.ancestor_id
 WHERE g.parent_id IS NOT NULL AND ancestry.depth<4
) SELECT group_id,ancestor_id,depth FROM ancestry ORDER BY 1,2,3`;
const rows=async(d,statement)=>(await d.query(statement)).map(row=>[row.group_id,row.ancestor_id,row.depth]);
const table=d=>rows(d,sql`SELECT group_id,ancestor_id,depth FROM device_group_paths ORDER BY 1,2,3`);
const view=d=>rows(d,sql`SELECT group_id,ancestor_id,depth FROM device_group_ancestors ORDER BY 1,2,3`);
const addGroup=(d,id,parent=null)=>d.exec(sql`INSERT INTO device_groups(id,name,created_at,parent_id) VALUES(${id},${'Gruppe '+id},${at},${parent})`);
const move=(d,id,parent)=>d.exec(sql`UPDATE device_groups SET parent_id=${parent} WHERE id=${id}`);
// Ancestors of one group as [ancestor, depth], nearest first.
const ancestry=async(d,id)=>(await d.query(sql`SELECT ancestor_id,depth FROM device_group_paths WHERE group_id=${id} ORDER BY depth`)).map(row=>[row.ancestor_id,row.depth]);

async function migrated(run){
 const d=await sourceDatabase();
 try{await run(d);}finally{await d.close();}
}

test('the table holds exactly the recursive ancestry and the view is a thin view over it',async()=>migrated(async d=>{
 // Two roots, siblings with a leaf, and a full chain down to depth 4.
 for(const [id,parent] of [['r1',null],['r2',null],['a','r1'],['b','r1'],['leaf','a'],['c1','r2'],['c2','c1'],['c3','c2'],['c4','c3']])await addGroup(d,id,parent);
 await d.exec(sql`INSERT INTO servers(id,name,token_hash,created_at) VALUES('s-1','s-1','fixture-s-1',${at})`);
 await d.exec(sql`INSERT INTO device_group_members(server_id,group_id) VALUES('s-1','c4')`);
 const expected=await rows(d,oracle);
 assert.ok(expected.some(([group,ancestor,depth])=>group==='c4'&&ancestor==='r2'&&depth===4),'the fixture reaches depth 4');
 assert.equal(expected.length,9+14,'nine self rows plus one row per ancestor: a, b, c1 one each, leaf and c2 two, c3 three, c4 four');
 assert.deepEqual(await table(d),expected,'the table holds exactly the recursive ancestry');
 assert.deepEqual(await view(d),expected,'the view returns the same rows');
 assert.deepEqual((await d.query(sql`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='device_group_ancestors' ORDER BY ordinal_position`)).map(row=>row.column_name),['group_id','ancestor_id','depth']);
 const definition=await d.one(sql`SELECT pg_get_viewdef('device_group_ancestors'::regclass) AS sql`).then(row=>row===null?null:row.sql);
 assert.doesNotMatch(definition,/RECURSIVE/i);
 assert.match(definition,/FROM device_group_paths/);
 const index=await d.one(sql`SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='device_group_paths' AND indexname='idx_device_group_paths_ancestor'`);
 assert.ok(index,'the ancestor index exists');
 assert.match(index.indexdef,/\(ancestor_id,/,'the index starts with ancestor_id');
 assert.deepEqual(await d.query(sql`SELECT server_id,group_id FROM device_group_members`),[{server_id:'s-1',group_id:'c4'}],'memberships are untouched');
}));

test('the table enforces its shape: primary key, depth range and self rows at depth 0',async()=>migrated(async d=>{
 await addGroup(d,'g');
 await assert.rejects(d.exec(sql`INSERT INTO device_group_paths VALUES('g','g',0)`),error=>error.code==='23505');
 await assert.rejects(d.exec(sql`INSERT INTO device_group_paths VALUES('x','y',5)`),error=>error.code==='23514');
 await assert.rejects(d.exec(sql`INSERT INTO device_group_paths VALUES('x','x',1)`),error=>error.code==='23514');
 await assert.rejects(d.exec(sql`INSERT INTO device_group_paths VALUES('x','y',0)`),error=>error.code==='23514');
}));

test('triggers maintain the paths on insert, subtree moves, multi-row moves and deletes; rejected statements change nothing',async()=>migrated(async d=>{
 const same=async label=>assert.deepEqual(await table(d),await rows(d,oracle),label+': table equals the recursive ancestry');
 await addGroup(d,'root');
 assert.deepEqual(await table(d),[['root','root',0]],'a root group gets exactly one row');
 await addGroup(d,'child','root');
 assert.deepEqual(await ancestry(d,'child'),[['child',0],['root',1]]);

 // Subtree a → b → c (height 2) under root; second branch s → t.
 await addGroup(d,'a','root');await addGroup(d,'b','a');await addGroup(d,'c','b');await addGroup(d,'s');await addGroup(d,'t','s');
 assert.deepEqual(await ancestry(d,'c'),[['c',0],['b',1],['a',2],['root',3]]);
 await move(d,'a','t');
 assert.deepEqual(await ancestry(d,'a'),[['a',0],['t',1],['s',2]]);
 assert.deepEqual(await ancestry(d,'b'),[['b',0],['a',1],['t',2],['s',3]]);
 assert.deepEqual(await ancestry(d,'c'),[['c',0],['b',1],['a',2],['t',3],['s',4]]);
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM device_group_paths WHERE ancestor_id='root' AND group_id IN ('a','b','c')`).then(row=>row===null?null:row.n),0,'no path to the old ancestor remains');
 await same('after moving a subtree');
 await move(d,'a',null);
 assert.deepEqual(await ancestry(d,'a'),[['a',0]]);
 assert.deepEqual(await ancestry(d,'b'),[['b',0],['a',1]]);
 assert.deepEqual(await ancestry(d,'c'),[['c',0],['b',1],['a',2]]);
 await same('after moving a subtree to the root level');
 await d.exec(sql`UPDATE device_groups SET name='Umbenannt' WHERE id='a'`);
 await same('after a rename');

 // Multi-row reparent: every child of p moves under q.
 await addGroup(d,'p');await addGroup(d,'k1','p');await addGroup(d,'k2','p');await addGroup(d,'k3','k2');await addGroup(d,'q','s');
 await d.exec(sql`UPDATE device_groups SET parent_id=${'q'} WHERE parent_id=${'p'}`);
 assert.deepEqual(await ancestry(d,'k1'),[['k1',0],['q',1],['s',2]]);
 assert.deepEqual(await ancestry(d,'k3'),[['k3',0],['k2',1],['q',2],['s',3]]);
 await same('after a multi-row move');

 await d.exec(sql`DELETE FROM device_groups WHERE id='k1'`);
 assert.equal(await d.one(sql`SELECT count(*) AS n FROM device_group_paths WHERE group_id='k1' OR ancestor_id='k1'`).then(row=>row===null?null:row.n),0,'a deleted leaf leaves no row');
 await same('after deleting a leaf');

 const unchanged=async(statement,code,label)=>{
  const before=await table(d);
  await assert.rejects(d.exec(statement),new RegExp(code),label);
  assert.deepEqual(await table(d),before,label+' leaves the table unchanged');
 };
 await unchanged(sql`DELETE FROM device_groups WHERE id='q'`,'device-group-has-children','deleting a parent');
 await unchanged(sql`UPDATE device_groups SET parent_id='c' WHERE id='a'`,'device-group-cycle','moving a group below its descendant');
 await unchanged(sql`UPDATE device_groups SET parent_id='a' WHERE id='a'`,'device-group-cycle','making a group its own parent');
 await addGroup(d,'u0');await addGroup(d,'u1','u0');await addGroup(d,'u2','u1');
 await unchanged(sql`UPDATE device_groups SET parent_id='u2' WHERE id='a'`,'device-group-depth-limit','moving a subtree too deep');
 await move(d,'a','t');
 assert.deepEqual(await ancestry(d,'c'),[['c',0],['b',1],['a',2],['t',3],['s',4]]);
 await unchanged(sql`INSERT INTO device_groups(id,name,created_at,parent_id) VALUES('too-deep','Zu tief',0,'c')`,'device-group-depth-limit','creating a sixth level');
 await unchanged(sql`INSERT INTO device_groups(id,name,created_at,parent_id) VALUES('orphan','Waise',0,'missing')`,'device-group-parent-missing','creating a group below a missing parent');
 await same('after all rejected statements');
}));

test('random histories keep the table equal to the recursive ancestry after every operation',async()=>migrated(async d=>{
 let seed=0x2545f491;
 const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
 const pick=list=>list[Math.floor(random()*list.length)];
 const ids=async()=>(await d.query(sql`SELECT id FROM device_groups ORDER BY id`)).map(row=>row.id);
 const parents=async()=>(await d.query(sql`SELECT DISTINCT parent_id FROM device_groups WHERE parent_id IS NOT NULL ORDER BY 1`)).map(row=>row.parent_id);
 const rejected={'device-group-cycle':0,'device-group-depth-limit':0,'device-group-has-children':0,'device-group-parent-missing':0};
 const kinds={insert:0,move:0,'move-root':0,'multi-move':0,delete:0};
 let next=0,maxDepth=0;
 const operations=600;
 for(let step=0;step<operations;step++){
  const groups=await ids(),roll=random();
  let kind,statement;
  if(!groups.length||roll<(groups.length<30?0.4:0.2)){
   kind='insert';
   const parent=!groups.length||random()<0.2?null:random()<0.03?'missing-'+step:pick(groups);
   statement=sql`INSERT INTO device_groups(id,name,created_at,parent_id) VALUES(${'g'+String(next++).padStart(4,'0')},${'Gruppe '+step},${at},${parent})`;
  }else if(roll<0.65){
   const parent=random()<0.15?null:pick(groups);kind=parent===null?'move-root':'move';
   statement=sql`UPDATE device_groups SET parent_id=${parent} WHERE id=${pick(groups)}`;
  }else if(roll<0.75){
   const from=await parents();if(!from.length){step--;continue;}
   kind='multi-move';
   statement=sql`UPDATE device_groups SET parent_id=${random()<0.2?null:pick(groups)} WHERE parent_id=${pick(from)}`;
  }else{
   kind='delete';
   statement=sql`DELETE FROM device_groups WHERE id=${pick(groups)}`;
  }
  const before=await table(d);
  try{await d.exec(statement);kinds[kind]++;}
  catch(error){
   const code=String(error?.message).match(/device-group-[a-z-]+/)?.[0];
   assert.ok(code in rejected,`step ${step} (${kind}) failed unexpectedly: ${error?.message}`);
   rejected[code]++;
   assert.deepEqual(await table(d),before,`step ${step}: rejected ${kind} (${code}) leaves the table unchanged`);
  }
  const after=await table(d);
  assert.deepEqual(after,await rows(d,oracle),`step ${step} (${kind}): table equals the recursive ancestry`);
  for(const [,,depth] of after)maxDepth=Math.max(maxDepth,depth);
 }
 assert.equal(maxDepth,4,'the history reaches a depth-4 path');
 for(const code of ['device-group-cycle','device-group-depth-limit','device-group-has-children'])assert.ok(rejected[code]>0,`the history hits ${code}: ${JSON.stringify(rejected)}`);
 for(const [kind,count] of Object.entries(kinds))assert.ok(count>0,`the history performs at least one successful ${kind}: ${JSON.stringify(kinds)}`);
}));

test('lookups by group and by ancestor search the table instead of recomputing the hierarchy',async()=>migrated(async d=>{
 // Forbid sequential scans, so the plan shows whether an index can serve the lookup.
 const plan=statement=>d.transaction(async tx=>{await tx.exec(sql`SET LOCAL enable_seqscan=off`);return (await tx.query(sql`EXPLAIN ${statement}`)).map(row=>row['QUERY PLAN']).join('\n');});
 const byGroup=await plan(sql`SELECT max(depth) FROM device_group_ancestors WHERE group_id=${'g'}`);
 assert.match(byGroup,/(Index (Only )?Scan using|Bitmap Index Scan on) device_group_paths_group_id_ancestor_id_pk\b/,byGroup);
 assert.doesNotMatch(byGroup,/\bon device_groups\b/,byGroup);
 assert.doesNotMatch(byGroup,/Recursive|CTE Scan|Seq Scan/,byGroup);
 const byAncestor=await plan(sql`SELECT group_id FROM device_group_ancestors WHERE ancestor_id=${'g'}`);
 assert.match(byAncestor,/(Index (Only )?Scan using|Bitmap Index Scan on) idx_device_group_paths_ancestor\b/,byAncestor);
 assert.doesNotMatch(byAncestor,/Recursive|CTE Scan|Seq Scan/,byAncestor);
}));
