// The one customer separation rule (runtime/customer-separation.mjs) on an
// isolated PostgreSQL test database: false while only the default customer
// exists, true once another customer exists (also a disabled one), and the
// fragment works twice in one statement. Its default customer id is the one of
// lib/default-customer.ts.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {sql} from '../../runtime/database.mjs';
import {customerSeparationSql,separationDefaultCustomerId} from '../../runtime/customer-separation.mjs';
import {defaultCustomerId} from '../../lib/default-customer.ts';
import {sourceDatabase} from '../support/source-database.mjs';
import {enableMultipleCustomers} from '../support/customer-separation.mjs';

assert.equal(separationDefaultCustomerId,defaultCustomerId,'runtime/customer-separation.mjs names the default customer of lib/default-customer.ts');

const d=await sourceDatabase();
try{
 const separated=async()=>(await d.one(sql`SELECT (${customerSeparationSql}) AS separated, (${customerSeparationSql}) AND (${customerSeparationSql}) AS twice`));
 assert.deepEqual({...await separated()},{separated:false,twice:false},'only the default customer: no separation');
 const now=Date.now();
 await d.exec(sql`UPDATE customers SET status='active',name='Umbenannt' WHERE id=${defaultCustomerId}`);
 assert.deepEqual({...await separated()},{separated:false,twice:false},'changing the default customer changes nothing');
 await d.exec(enableMultipleCustomers());
 await d.exec(sql`INSERT INTO customers(id,name,status,created_at,updated_at) VALUES(${randomUUID()},'Zweiter Kunde','disabled',${now},${now})`);
 assert.deepEqual({...await separated()},{separated:true,twice:true},'a second customer, also a disabled one, separates');
 console.log('PASS customer separation: one customer, a second customer, the default id and two uses in one statement.');
}finally{d.close();}
