import { acceptedReportType, createReportLimiter, readReportBody, ReportError, reportClientKey, summarizeReports } from '@/lib/server/csp-reports';

// Anonymous sink for report-only CSP violations. Browsers send these
// without session or a matching Origin. Every answer is an empty status, and
// only the reduced summary from lib/server/csp-reports.ts reaches the log.
export const dynamic = 'force-dynamic';

// One line per minute with drops, so a quiet log during a flood is not read as
// "no violations".
const allow = createReportLimiter({ onDropped: dropped => console.warn('csp-report-dropped ' + JSON.stringify({ dropped })) });
const empty = (status: number) => new Response(null, { status });

export async function POST(request: Request) {
  if (!allow(reportClientKey(request.headers))) return empty(429);
  if (!acceptedReportType(request.headers.get('content-type'))) return empty(415);
  try {
    const summary = summarizeReports(await readReportBody(request));
    if (summary.count) console.warn('csp-report ' + JSON.stringify(summary));
    return empty(204);
  } catch (error) {
    return empty(error instanceof ReportError ? error.status : 400);
  }
}
