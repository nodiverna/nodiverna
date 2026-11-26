// The top bar logo (ui/shell/brand-logo-model.ts, docs/branding.md): each rule and its order. The context customer
// wins over the single customer of an account, Multiple customers off ignores customer logos, an account of the
// default customer only gets the portal logo, and without any logo the result is null (the Nodiverna mark).
import '../../support/register.mjs';
import assert from 'node:assert/strict';
const {topbarLogo}=await import('../../../ui/shell/brand-logo-model.ts');

const defaultCustomerId='00000000-0000-4000-8000-000000000100',contoso='c-contoso',fabrikam='c-fabrikam';
const asset=name=>({url:`/api/branding/${name}?v=0123456789abcdef`,contentType:'image/png',width:100,height:25,size:100,updatedAt:1});
const portal={light:asset('portal/light'),dark:asset('portal/dark'),icon:null};
const branding={portal,customers:{[contoso]:{light:asset('contoso/light'),dark:null},[fabrikam]:{light:null,dark:asset('fabrikam/dark')}}};
const logo=(changes={})=>topbarLogo({branding,multipleCustomers:true,contextCustomerId:null,visibleCustomerIds:[],defaultCustomerId,...changes});
const urls=pair=>pair&&[pair.light?.url??null,pair.dark?.url??null];

assert.deepEqual(urls(logo({contextCustomerId:contoso,visibleCustomerIds:[contoso,fabrikam]})),[asset('contoso/light').url,null],'1. the context customer');
assert.deepEqual(urls(logo({contextCustomerId:contoso,visibleCustomerIds:[fabrikam]})),[asset('contoso/light').url,null],'the context customer wins over the single customer of the account');
assert.deepEqual(urls(logo({contextCustomerId:'c-other',visibleCustomerIds:[fabrikam]})),[null,asset('fabrikam/dark').url],'2. a context customer without a logo: the single customer of the account');
assert.deepEqual(urls(logo({visibleCustomerIds:[fabrikam]})),[null,asset('fabrikam/dark').url],'2. an account that sees exactly one customer with a logo');
assert.deepEqual(urls(logo({visibleCustomerIds:[contoso,fabrikam]})),[portal.light.url,portal.dark.url],'3. two visible customers outside a customer context: the portal logo');
assert.deepEqual(urls(logo({visibleCustomerIds:[defaultCustomerId],contextCustomerId:defaultCustomerId,branding:{portal,customers:{[defaultCustomerId]:{light:asset('x'),dark:null}}}})),[portal.light.url,portal.dark.url],'an account of the default customer gets the portal logo');
assert.deepEqual(urls(logo({multipleCustomers:false,contextCustomerId:contoso,visibleCustomerIds:[contoso]})),[portal.light.url,portal.dark.url],'Multiple customers off ignores customer logos');
assert.deepEqual(urls(logo({branding:{portal:{light:null,dark:asset('portal/dark'),icon:asset('icon')},customers:{}}})),[null,asset('portal/dark').url],'3. a portal dark logo alone counts');
assert.equal(logo({branding:{portal:{light:null,dark:null,icon:asset('icon')},customers:{}}}),null,'4. no logo: null (the icon is no logo)');
assert.equal(logo({branding:undefined}),null,'no console data yet');
assert.equal(logo({contextCustomerId:contoso,branding:{portal:{light:null,dark:null,icon:null},customers:{[contoso]:{light:null,dark:null}}}}),null,'an empty customer entry counts as no logo');
console.log('PASS brand logo model: context customer, single customer, portal logo and the Nodiverna mark, in this order.');
