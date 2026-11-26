import {env} from 'cloudflare:workers';
import migrations from '../../drizzle/meta/_journal.json';
import {sharedDatabase} from '../../runtime/database.mjs';
import {sql,type Queryable} from './db';

type Journal={entries:{tag:string}[]};
type Bucket={head(key:string):Promise<unknown>};
export type ReadinessInput={
 /** The pool, or null without DATABASE_URL. */
 database:Queryable|null;
 bucket:Bucket|null;
 journal?:Journal;
 timeoutMs?:number;
};
/** The migration file names this build ships (drizzle/meta/_journal.json). */
export const shippedMigrations=(journal:Journal=migrations)=>journal.entries.map(entry=>`${entry.tag}.sql`);

function within<T>(promise:Promise<T>,ms:number):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Readiness check timed out.')),ms);});
 return Promise.race([promise,timeout]).finally(()=>clearTimeout(timer));
}

/**
 * Whether this instance may receive traffic: the database is configured and
 * reachable, every shipped migration is applied (newer extra rows are
 * allowed, so an older image can run after a compatible migration) and the object
 * storage answers. An empty release catalog does not matter: a new
 * installation imports its agent release after the start. It answers within
 * timeoutMs (default 4 s) also when the database does not respond.
 */
export async function isReady({database,bucket,journal=migrations,timeoutMs=4000}:ReadinessInput):Promise<boolean>{
 try{
  if(!database||!bucket)return false;
  const required=shippedMigrations(journal);
  const applied=await within(database.query<{name:string}>(sql`SELECT name FROM _serverdesk_migrations WHERE name IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(required)}::jsonb))`),timeoutMs);
  const names=new Set(applied.map(row=>row.name));
  if(required.some(name=>!names.has(name)))return false;
  await within(Promise.resolve(bucket.head('__healthcheck__')),timeoutMs);
  return true;
 }catch{return false;}
}

/** isReady with the process pool and the runtime object storage. */
export async function readiness():Promise<boolean>{
 let database:Queryable|null=null;
 try{database=sharedDatabase() as unknown as Queryable|null;}catch{database=null;}
 return isReady({database,bucket:(env as unknown as {BUCKET?:Bucket}).BUCKET??null});
}
