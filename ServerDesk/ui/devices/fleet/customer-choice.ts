import {defaultCustomerId} from '@/lib/default-customer';
import type {MessageKey} from '@/lib/i18n/translate';

// The customer field when a root group is created (docs/customers.md). It only
// appears when the viewer sees more than one customer; otherwise the request
// stays without customerId and the server keeps the default customer.
export type CustomerOption={id:string;name:string};
/** Message key of the hint under the customer field. */
export const rootGroupCustomerHint:MessageKey='groups.customerHint';
/** True when a group without parent should name its customer. */
export function chooseRootGroupCustomer(customers:readonly CustomerOption[]|undefined,parentId:string|null|undefined){return !parentId&&(customers?.length??0)>1;}
/** The selected id while it is still offered, else the default customer when listed, else the first entry. */
export function rootGroupCustomerId(customers:readonly CustomerOption[]|undefined,selected=''){
 const list=customers??[];
 if(selected&&list.some(customer=>customer.id===selected))return selected;
 return (list.find(customer=>customer.id===defaultCustomerId)??list[0])?.id??'';
}
