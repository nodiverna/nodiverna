// A console with only the default customer, which is always the case while "Multiple customers" is off
// (docs/customers.md): every customer surface stays hidden through its own pure gate. Customer folders and
// the customer view, the root-group customer field, the fleet customer column, the Add device customer choice, the
// catalog owner, the cross-customer hints and locks and the customer scope of notification rules; and the navigator
// keeps Settings › Customers for every global Owner (the page of the switch) and hides it for everyone else.
import '../../support/register.mjs';
import assert from 'node:assert/strict';

const {customerFolders}=await import('../../../ui/devices/fleet/customer-folders.ts');
const {customerViewAvailable}=await import('../../../ui/devices/fleet/fleet-scope.ts');
const {chooseRootGroupCustomer}=await import('../../../ui/devices/fleet/customer-choice.ts');
const {availableFleetColumns,customerColumnDistinguishes}=await import('../../../ui/devices/fleet/fleet-columns.ts');
const {enrollStartChoice,installerCustomer,installerCopy}=await import('../../../ui/devices/add-device/add-device-model.ts');
const {showCatalogOwner,catalogOwnerRequest}=await import('../../../ui/base/catalog-owner.ts');
const {crossCustomerHint,crossCustomerLockReason,scheduleCustomerLockReason,targetCustomerCount}=await import('../../../ui/base/cross-customer.ts');
const {ruleCovers}=await import('../../../lib/server/notifications/notification-routing.ts');
const nav=await import('../../../ui/shell/nav-model.ts');

let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const defaultCustomer='00000000-0000-4000-8000-000000000100';
// The console data of a portal with one customer: the server sends multipleCustomers false (ConsoleData).
const customers=[{id:defaultCustomer,name:'Standardkunde'}];
const devices=[{id:'d1',customerId:defaultCustomer,customerName:'Standardkunde'},{id:'d2',customerId:defaultCustomer,customerName:'Standardkunde'}];
const groups=[{id:'g1',customerId:defaultCustomer},{id:'g2',customerId:defaultCustomer}];
const multipleCustomers=false;

// Customer folders, folder menus and the customer view with its palette entries.
check(customerFolders(customers,groups,devices,devices),null,'no customer folders (and so no folder menus)');
check(customerViewAvailable(customers,defaultCustomer),false,'no customer view, so no palette entry for it');
// The customer field of Create group.
check([chooseRootGroupCustomer(customers,null),chooseRootGroupCustomer(customers,'g1')],[false,false],'Create group asks for no customer');
// The fleet customer column and the customer filter of Devices, Alarms and Problems.
check(availableFleetColumns(multipleCustomers,true).includes('customer'),false,'the fleet column list has no customer column');
check(customerColumnDistinguishes(devices),false,'the customer column distinguishes nothing');
// Add device: One device and Several devices.
check(enrollStartChoice({routeCustomer:defaultCustomer,routeGroup:'g1',groups:[['g1','Gruppe 1']],multipleCustomers,customers,groupCustomers:{g1:defaultCustomer}}),{customerId:'',groupId:'g1'},'One device: no customer choice');
check(installerCustomer([{...customers[0],status:'active'}],{multipleCustomers,chosen:''})?.id,defaultCustomer,'Several devices: the default customer without a choice');
check(installerCopy(multipleCustomers,'Standardkunde','en').table,'Installers','Several devices: the copy names no customer');
// The catalog owner field and labels.
const catalog={separated:false,libraryWritable:true,customers};
check([showCatalogOwner(catalog),catalogOwnerRequest(catalog,defaultCustomer)],[false,{}],'no catalog owner field and no owner in the request');
// The cross-customer hints and locks, also for an account without the right.
const count=targetCustomerCount(devices,['d1','d2']);
check([count,crossCustomerHint(count,'en'),crossCustomerLockReason({permissions:[]},count,'en'),scheduleCustomerLockReason(count,'en')],[1,null,null,null],'no cross-customer hint, lock or schedule lock');
// The customer scope of notification rules applies only with several customers.
check(ruleCovers({scopeType:'customer',scopeId:defaultCustomer},{customerId:defaultCustomer,multipleCustomers,groupIds:[]}),false,'a customer-scoped notification rule covers nothing');
// The navigator: Settings › Customers stays for every global Owner and only for them.
const node=nav.navNode('settings.customers');
check(node.visible({viewer:{permissions:['*']},multipleCustomers}),true,'Owner: the Customers page with the switch');
check([node.visible({viewer:{permissions:[]},multipleCustomers}),node.visible({viewer:{permissions:['portal.users.manage','portal.roles.manage']},multipleCustomers})],[false,false],'non-Owners: no Customers page');
check(nav.navigatorPages('settings',{viewer:{permissions:['*']},multipleCustomers}).some(page=>page.section==='customers'),true,'the Owner navigator lists it');

console.log(`PASS single customer surfaces (${checks} checks): with only the default customer no customer folder, view, column, field, owner, cross-customer hint or customer rule scope; Settings › Customers stays for Owners.`);
