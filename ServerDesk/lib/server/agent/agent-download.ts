import {HttpError} from '../context';
import {latestRelease,verifiedRelease} from './releases';
import {storedReleaseFile} from './release-source';

// The Owner download of the agent EXE: the latest release of the catalog,
// streamed from its stored chunks (lib/server/agent/release-source.ts) one chunk at a time,
// each checked for length and SHA-256. The executable never occupies the
// server's memory as a complete buffer; a missing or changed chunk aborts the
// stream.
export async function nativeAgentDownload(){
 const release=await latestRelease();if(!release)throw new HttpError('apiError.release.noneAvailable');
 const exe=verifiedRelease(release.manifest,release.signature).exe;if(!exe)throw new HttpError('apiError.release.noneAvailable');
 const stored=await storedReleaseFile(release.id,String(exe.path));if(!stored)throw new HttpError('apiError.release.noneAvailable');
 return new Response(stored.body,{headers:{'Content-Type':'application/octet-stream','Content-Length':String(exe.size),'Content-Disposition':`attachment; filename="ServerDesk.Agent.exe"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Agent-Version':release.version,'X-Agent-SHA256':exe.sha256,'X-Agent-Size':String(exe.size)}});
}
