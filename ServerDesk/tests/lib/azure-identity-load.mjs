// The Azure Blob path of runtime/storage.mjs (azureBucket, OBJECT_STORAGE_DRIVER=azure
// with AZURE_STORAGE_ACCOUNT_URL and no connection string) with the installed
// @azure/identity (on @azure/msal-node 7.1 or newer): DefaultAzureCredential and
// BlobServiceClient load the way the runtime imports them and construct with an
// account URL and the credential, without a token request or any other network call.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
let checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
{
 const msal=createRequire(require.resolve('@azure/identity'))('@azure/msal-node/package.json').version;
 const [major,minor]=msal.split('.').map(Number);
 check(major>7||major===7&&minor>=1,true,`@azure/identity loads @azure/msal-node ${msal}, at least 7.1.0`);
 // The same dynamic imports as azureBucket in runtime/storage.mjs.
 const {DefaultAzureCredential}=await import('@azure/identity');
 const {BlobServiceClient}=await import('@azure/storage-blob');
 const credential=new DefaultAzureCredential();
 check(typeof credential.getToken,'function','DefaultAzureCredential constructs and offers getToken');
 const service=new BlobServiceClient('https://fixture.blob.core.windows.net',credential);
 check([service.url.replace(/\/$/,''),service.accountName],['https://fixture.blob.core.windows.net','fixture'],'BlobServiceClient takes the account URL and the credential');
 const container=service.getContainerClient('serverdesk');
 check(container.url,'https://fixture.blob.core.windows.net/serverdesk','a container client derives its URL offline');
 check(container.getBlockBlobClient('agent/releases/4.20.0.zip').url,'https://fixture.blob.core.windows.net/serverdesk/agent/releases/4.20.0.zip','a blob client derives its URL offline');
 console.log(`PASS azure identity load (${checks} checks): @azure/identity on @azure/msal-node ${msal}, DefaultAzureCredential and BlobServiceClient construct offline with an account URL and the credential.`);
}
