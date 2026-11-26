import {REMOTE_DESKTOP_AVAILABLE} from '@/lib/rdp-feature';
import RemoteDesktopPaused from '@/ui/devices/remote/remote-desktop-paused';
// Rendered per request so Next can put the request's CSP nonce on its scripts.
export const dynamic='force-dynamic';

export default async function RemoteDesktopPage(){
 if(!REMOTE_DESKTOP_AVAILABLE)return <RemoteDesktopPaused/>;
 const {default:RemoteDesktopClient}=await import('@/ui/devices/remote/remote-desktop-client');
 return <RemoteDesktopClient/>;
}
