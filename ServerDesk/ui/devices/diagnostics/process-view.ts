import type {Server} from '@/lib/types';

export type ProcessRow = Record<string, unknown>;
export type ProcessDiagnosis = {
  id: string;
  data: {at: string; data: Record<string, unknown>} | null;
};
export type ProcessView = {
  rows: ProcessRow[];
  byIdentity: ReadonlyMap<string, ProcessRow>;
  source: 'automatic' | 'diagnostic' | 'none';
  collectedAt: string | null;
  fresh: boolean;
  count: number;
  truncated: boolean;
  intervalSeconds: number | null;
  collectionError: string;
};

const MAX_AGE = 120000;
const FUTURE_TOLERANCE = 10000;
const present = (value: unknown) => value !== undefined && value !== null && value !== '';

// Keep the sub-millisecond part: PID reuse must never inherit another process's identity.
function preciseTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 60) return null;
  const match = value.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{1,9}))?(?:Z|[+-]\d{2}:\d{2})$/);
  const parsed = Date.parse(value);
  if (!match || !Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().split('.')[0] + '.' + (match[1] ?? '').padEnd(9, '0');
}

export function processIdentity(row: ProcessRow): string | null {
  const start = preciseTimestamp(row.startedAt);
  return typeof row.pid === 'number' && Number.isInteger(row.pid) && row.pid > 0 && row.pid <= 2147483647 && start
    ? `${row.pid}:${start}` : null;
}

function measuredAt(value: unknown, now: number): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= now + FUTURE_TOLERANCE ? parsed : null;
}

function processRows(value: unknown): ProcessRow[] {
  return Array.isArray(value) ? value.filter((row): row is ProcessRow => !!row && typeof row === 'object' && !Array.isArray(row)) : [];
}

export function processView(server: Server, diagnosis: ProcessDiagnosis | undefined, now: number): ProcessView {
  const inventory = server.snapshot?.processInventory;
  const automaticAt = measuredAt(inventory?.collectedAt, now);
  const diagnosticAt = measuredAt(diagnosis?.data?.at, now);
  const automaticValid = !!inventory && inventory.complete === true && automaticAt !== null;
  const diagnosticValid = diagnosticAt !== null && Array.isArray(diagnosis?.data?.data.processes);
  const automatic = automaticValid && (!diagnosticValid || automaticAt! >= diagnosticAt!);
  const source = automatic ? 'automatic' : diagnosticValid ? 'diagnostic' : 'none';
  const at = automatic ? automaticAt : diagnosticValid ? diagnosticAt : null;
  const collectedAt = automatic ? inventory!.collectedAt : diagnosticValid ? diagnosis!.data!.at : null;
  const connected = !!server.lastSeen && now - server.lastSeen < MAX_AGE && server.maintenance?.state !== 'updating';
  const fresh = connected && at !== null && now - at < MAX_AGE;
  let items = source === 'automatic' ? processRows(server.snapshot?.processes) : source === 'diagnostic' ? processRows(diagnosis?.data?.data.processes) : [];
  if (source === 'automatic' && diagnosticValid) {
    const enrichment = new Map(processRows(diagnosis?.data?.data.processes).flatMap(row => {
      const identity = processIdentity(row);
      return identity ? [[identity, row] as const] : [];
    }));
    items = items.map(row => {
      const identity = processIdentity(row);
      const details = identity ? enrichment.get(identity) : undefined;
      if (!details) return row;
      const enriched = {...row};
      for (const key of ['user', 'sid', 'path']) if (!present(enriched[key]) && present(details[key])) enriched[key] = details[key];
      return enriched;
    });
  }
  const rawCount = source === 'automatic' ? inventory?.count : diagnosis?.data?.data.count;
  return {
    rows: items,
    byIdentity: new Map(items.flatMap(row => {
      const identity = processIdentity(row);
      return identity ? [[identity, row] as const] : [];
    })),
    source,
    collectedAt,
    fresh,
    count: typeof rawCount === 'number' && Number.isFinite(rawCount) ? Math.max(items.length, rawCount) : items.length,
    truncated: source === 'automatic' ? inventory?.truncated === true : source === 'diagnostic' && diagnosis?.data?.data.truncated === true,
    intervalSeconds: inventory?.intervalSeconds ?? null,
    collectionError: inventory?.error ?? '',
  };
}

export function currentKillCandidate(view: ProcessView, selected: ProcessRow | null): ProcessRow | null {
  const identity = selected && processIdentity(selected);
  if (!view.fresh || !identity) return null;
  const current = view.byIdentity.get(identity);
  return current && current.protected === false ? current : null;
}

export type ProcessSortColumn = 'name' | 'pid' | 'cpu' | 'memory';
export type ProcessSort = {column: ProcessSortColumn; direction: 'asc' | 'desc'};
/** The first direction of each process column: CPU and memory start with the largest, name and PID with the smallest. */
export const processSortFirst: Record<ProcessSortColumn, 'asc' | 'desc'> = {name: 'asc', pid: 'asc', cpu: 'desc', memory: 'desc'};

/** A CPU, memory or PID value that was measured: a finite number of 0 or more; anything else is unmeasured (null). */
export const measuredValue = (input: unknown): number | null => typeof input === 'number' && Number.isFinite(input) && input >= 0 ? input : null;

/**
 * The process rows in the order of the table sort (a new array). Names compare naturally; CPU,
 * memory and PID put unmeasured values last in both directions; equal values keep the PID order.
 */
export function sortProcesses(rows: readonly ProcessRow[], sort: ProcessSort): ProcessRow[] {
  const factor = sort.direction === 'asc' ? 1 : -1;
  const pid = (a: ProcessRow, b: ProcessRow) => Number(a.pid) - Number(b.pid);
  return [...rows].sort((a, b) => {
    if (sort.column === 'name') return String(a.name ?? '').localeCompare(String(b.name ?? ''), 'de', {numeric: true}) * factor || pid(a, b);
    const key = sort.column === 'cpu' ? 'cpuPercent' : sort.column === 'memory' ? 'memoryMb' : 'pid';
    const left = measuredValue(a[key]), right = measuredValue(b[key]);
    if (left === null) return right === null ? pid(a, b) : 1;
    if (right === null) return -1;
    return (left - right) * factor || pid(a, b);
  });
}
