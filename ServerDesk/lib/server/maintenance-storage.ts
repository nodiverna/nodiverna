import {sql,type Queryable} from './db';

// The size facts of the page Settings → Data retention (docs/self-hosting.md,
// "Maintenance"). They must stay cheap on a large installation: the sizes and
// row counts come only from the catalog (pg_database_size,
// pg_total_relation_size) and the statistics view pg_stat_user_tables, so the
// row counts are estimates (n_live_tup). The one statement that reads a retained
// table is the sum of transfer_chunks.size: that table holds only the chunks of
// transfers that are not cleared yet, and the sum is a single aggregate without
// a join. Each statement may fail on its own (a missing privilege): its values
// are null, the page still loads, and the failure goes to the server log once.

/** The tables whose rows the maintenance deletes or clears (runtime/maintenance.mjs, runMaintenance). */
export const retainedTables=['audit','jobs','job_outputs','device_software_changes','alerts','notification_events','notification_deliveries','agent_integrity_events','transfers','transfer_chunks'] as const;
export type RetainedTable=typeof retainedTables[number];
/** Size with indexes and TOAST, and the estimated number of live rows; null when the statistics could not be read. */
export type TableStorage={bytes:number|null;rows:number|null};
export type MaintenanceStorage={
 /** pg_database_size of the current database. */
 databaseBytes:number|null;
 tables:Record<RetainedTable,TableStorage>;
 /** The object storage of file transfers that are not cleared: the sum of transfer_chunks.size. */
 transferObjectBytes:number|null;
};
/** The customers with their own audit retention (customers.audit_retention_days). */
export type CustomerRetention={count:number;minDays:number|null;maxDays:number|null};

export const maintenanceStorageQueries={
 database:sql`SELECT pg_database_size(current_database()) AS bytes`,
 // The schema of the app: an isolated database or a schema of its own keeps other tables of the same name out.
 tables:sql`SELECT relname AS name,pg_total_relation_size(relid) AS bytes,n_live_tup AS rows FROM pg_stat_user_tables WHERE schemaname=current_schema() AND relname IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify(retainedTables)}::jsonb))`,
 transferObjects:sql`SELECT COALESCE(sum(size),0)::bigint AS bytes FROM transfer_chunks`,
};

const numberOrNull=(value:unknown)=>{const number=typeof value==='string'?Number(value):value;return typeof number==='number'&&Number.isFinite(number)&&number>=0?number:null;};
const emptyTables=()=>Object.fromEntries(retainedTables.map(name=>[name,{bytes:null,rows:null}])) as Record<RetainedTable,TableStorage>;

/**
 * The storage facts. A failing statement gives null for its values; all
 * failures of one call are written to the server log in one line, never into
 * the answer.
 */
export async function maintenanceStorage(database:Queryable,log:(line:string)=>void=line=>console.error(line)):Promise<MaintenanceStorage>{
 const failures:string[]=[];
 const attempt=async<T>(name:string,read:()=>Promise<T>):Promise<T|null>=>{
  try{return await read();}catch(error){failures.push(`${name}: ${error instanceof Error?error.message:String(error)}`);return null;}
 };
 const [database_,tables,transfers]=await Promise.all([
  attempt('database size',()=>database.one<{bytes:unknown}>(maintenanceStorageQueries.database)),
  attempt('table sizes',()=>database.query<{name:string;bytes:unknown;rows:unknown}>(maintenanceStorageQueries.tables)),
  attempt('file transfer storage',()=>database.one<{bytes:unknown}>(maintenanceStorageQueries.transferObjects)),
 ]);
 if(failures.length)log(`ServerDesk: Data retention storage facts unavailable (${failures.join('; ')})`);
 const byTable=emptyTables();
 for(const row of tables??[])if((retainedTables as readonly string[]).includes(row.name))byTable[row.name as RetainedTable]={bytes:numberOrNull(row.bytes),rows:numberOrNull(row.rows)};
 return {databaseBytes:numberOrNull(database_?.bytes),tables:byTable,transferObjectBytes:numberOrNull(transfers?.bytes)};
}

/** How many customers keep their own audit retention, with the shortest and the longest. */
export async function customerRetention(database:Queryable):Promise<CustomerRetention>{
 const row=await database.one<{count:number;minDays:number|null;maxDays:number|null}>(sql`SELECT count(*)::int AS count,min(audit_retention_days)::int AS "minDays",max(audit_retention_days)::int AS "maxDays" FROM customers WHERE audit_retention_days IS NOT NULL`);
 const count=Number(row?.count??0);
 return count>0?{count,minDays:numberOrNull(row?.minDays),maxDays:numberOrNull(row?.maxDays)}:{count:0,minDays:null,maxDays:null};
}
