import {enrollWithInstaller} from '@/lib/server/agent/customer-installers';

// Device enrollment through a customer installer (docs/customers.md). No
// session and no Origin check: the installer key in the body is the
// credential, and the device lands with the installer's customer only.
export const dynamic='force-dynamic';
export function POST(request:Request){return enrollWithInstaller(request);}
