// Server-only: the typed entry to the data layer (runtime/database.mjs). SQL
// lives only in domain modules under lib/server/; app/ never imports this
// file (eslint.config.mjs). Values reach SQL only through the sql tag.
import {compile,dbNow as clock,sharedDatabase,sql as tag,type SqlFragment} from '../../runtime/database.mjs';
import {StorageUnavailableError} from './errors/failure';

/** An SQL fragment of the sql tag: text with its bind parameters. */
export type Sql=SqlFragment;
export type SqlValue=string|number|bigint|boolean|null|Sql;
export type Row=Record<string,unknown>;
export interface Queryable{
 /** All rows. */
 query<T=Row>(statement:Sql):Promise<T[]>;
 /** The first row or null. */
 one<T=Row>(statement:Sql):Promise<T|null>;
 /** A write without RETURNING; a write with RETURNING uses query or one. */
 exec(statement:Sql):Promise<{rowCount:number}>;
}
/** The handle inside a transaction callback. It is invalid after the transaction ends. */
export type Tx=Queryable;
export interface Database extends Queryable{
 /**
  * Runs the callback in one SERIALIZABLE transaction. On a serialization
  * failure or deadlock the whole callback runs again, at most maxAttempts (10)
  * attempts in total with a random wait of up to 250 ms before each new one
  * (runtime/database.mjs), so it must not have effects outside the database.
  * A callback that catches such an error must throw it again unchanged.
  */
 transaction<T>(callback:(tx:Tx)=>Promise<T>,options?:{readOnly?:boolean}):Promise<T>;
 close():Promise<void>;
}
type SqlTag={
 (strings:TemplateStringsArray,...values:SqlValue[]):Sql;
 /** Joins fragments with a separator (default ", "). */
 join(fragments:Sql[],separator?:Sql):Sql;
 /** A table or column name matching ^[a-z_][a-z0-9_]*$; anything else throws. */
 ident(name:string):Sql;
};
export const sql=tag as unknown as SqlTag;

/** The process-wide pool. Without DATABASE_URL every access fails with 503 STORAGE_UNAVAILABLE. */
export function db():Database{
 const database=sharedDatabase() as unknown as Database|null;
 if(!database)throw new StorageUnavailableError();
 return database;
}

/**
 * The current time in milliseconds, read by the database in the statement
 * that uses it, so a time check commits with its write.
 */
export const dbNow:Sql=clock;

/**
 * A step that runs only when the step directly before it changed at least one
 * row (auditAfterChange in lib/server/audit.ts); otherwise it counts as zero rows.
 */
export type AfterChange={readonly afterChange:Sql};
export type Step=Sql|AfterChange;
/** Row count and rows (for SELECT and RETURNING) of one step. */
export type StepResult={rowCount:number;rows:Row[]};

const strip=(text:string)=>text.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\//g,' ');
/** Whether a statement returns rows: SELECT, VALUES, or a write with RETURNING. */
function returnsRows(statement:Sql){
 const text=strip((compile as (value:unknown)=>{text:string})(statement).text).trim();
 if(/\bRETURNING\b/i.test(text))return true;
 if(/^(SELECT|VALUES|SHOW|TABLE)\b/i.test(text))return true;
 return /^WITH\b/i.test(text)&&!/\b(INSERT|UPDATE|DELETE)\b/i.test(text);
}

/**
 * Runs the steps in order on the transaction handle and returns the row count
 * and rows of each. Every guard inside a step is evaluated at its position, in
 * this transaction.
 */
export async function runSteps(tx:Tx,steps:readonly Step[]):Promise<StepResult[]>{
 const results:StepResult[]=[];
 for(const step of steps){
  if('afterChange' in step){
   if(!results.length||results[results.length-1].rowCount===0){results.push({rowCount:0,rows:[]});continue;}
   results.push(await runStatement(tx,step.afterChange));
  }else results.push(await runStatement(tx,step));
 }
 return results;
}
async function runStatement(tx:Tx,statement:Sql):Promise<StepResult>{
 if(returnsRows(statement)){const rows=await tx.query(statement);return {rowCount:rows.length,rows};}
 return {rowCount:(await tx.exec(statement)).rowCount,rows:[]};
}

/** Runs the steps in one transaction (runSteps): all of them commit or none. */
export async function commitAll(steps:readonly Step[]):Promise<StepResult[]>{
 return db().transaction(tx=>runSteps(tx,steps));
}

/**
 * The JSON value (jsonb) at `path` of a text column that holds a JSON object,
 * or NULL when the column is NULL, no JSON object or has no such path.
 */
export const jsonPath=(column:Sql,...path:string[]):Sql=>sql`(CASE WHEN ${column} IS JSON OBJECT THEN ${column}::jsonb #> ${'{'+path.join(',')+'}'}::text[] END)`;
/** Like jsonPath, as text: strings without quotes, numbers and booleans as their JSON text. */
export const jsonText=(column:Sql,...path:string[]):Sql=>sql`(CASE WHEN ${column} IS JSON OBJECT THEN ${column}::jsonb #>> ${'{'+path.join(',')+'}'}::text[] END)`;
/** The elements of a jsonb value as text rows (column value); anything but an array gives none. */
export const jsonArrayText=(value:Sql):Sql=>sql`jsonb_array_elements_text(CASE WHEN jsonb_typeof(${value})='array' THEN ${value} ELSE '[]'::jsonb END)`;
