import {readiness} from '@/lib/server/readiness';
export const dynamic = 'force-dynamic';
// Not ready without a database, with a database that misses a migration of
// this build, without object storage or with an invalid release signature.
export async function GET() {
  const ready = await readiness();
  return ready
    ? Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } })
    : Response.json({ status: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
}
