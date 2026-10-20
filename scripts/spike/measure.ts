import type { DeviceEvent, SnapshotEvent, SnapshotSource } from '../../src/domain/events/schema';
import { snapshotSourceSchema } from '../../src/domain/events/schema';

// Un mecanismo puede ver el corte hasta 5 min antes de que la persona toque el botón
export const LEAD_WINDOW_MS = 5 * 60_000;
// Y la luz puede volver a verse hasta 60 min después del botón hay_luz
export const END_WINDOW_MS = 60 * 60_000;

export type TruthOutage = { start: number; end: number | null };
export type MechanismRow = {
  source: SnapshotSource;
  truthStart: number;
  startLatencyMs: number | null;
  endLatencyMs: number | null;
};
export type SourceSummary = { hits: number; total: number; medianStartLatencyMs: number | null };

const byTime = <T extends { at: number; id: string }>(a: T, b: T): number =>
  a.at - b.at || a.id.localeCompare(b.id);

// Pares sin_luz → siguiente hay_luz; lo demás se ignora
function buildTruths(events: readonly DeviceEvent[]): TruthOutage[] {
  const reports = events.filter((e) => e.kind === 'report').sort(byTime);
  const truths: TruthOutage[] = [];
  let open: TruthOutage | null = null;
  for (const r of reports) {
    if (r.value === 'sin_luz' && !open) {
      open = { start: r.at, end: null };
      truths.push(open);
    } else if (r.value === 'hay_luz' && open) {
      open.end = r.at;
      open = null;
    }
  }
  return truths;
}

function startLatency(snaps: readonly SnapshotEvent[], truth: TruthOutage): number | null {
  const hit = snaps.find(
    (s) =>
      !s.plugged &&
      s.at >= truth.start - LEAD_WINDOW_MS &&
      (truth.end === null || s.at < truth.end),
  );
  return hit ? hit.at - truth.start : null;
}

function endLatency(snaps: readonly SnapshotEvent[], truth: TruthOutage): number | null {
  if (truth.end === null) return null;
  const end = truth.end;
  const hit = snaps.find(
    (s) => s.plugged && s.at >= end - LEAD_WINDOW_MS && s.at <= end + END_WINDOW_MS,
  );
  return hit ? hit.at - end : null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const low = sorted[mid - 1] as number;
  const high = sorted[mid] as number;
  return sorted.length % 2 === 0 ? (low + high) / 2 : high;
}

function summarize(rows: readonly MechanismRow[]): SourceSummary {
  const latencies = rows.flatMap((r) => (r.startLatencyMs === null ? [] : [r.startLatencyMs]));
  return { hits: latencies.length, total: rows.length, medianStartLatencyMs: median(latencies) };
}

export function measureMechanisms(events: readonly DeviceEvent[]): {
  truths: TruthOutage[];
  rows: MechanismRow[];
  bySource: Record<SnapshotSource, SourceSummary>;
} {
  const truths = buildTruths(events);
  const snapshots = events.filter((e) => e.kind === 'snapshot').sort(byTime);
  const rows: MechanismRow[] = [];
  for (const truth of truths) {
    for (const source of snapshotSourceSchema.options) {
      const own = snapshots.filter((s) => s.source === source);
      rows.push({
        source,
        truthStart: truth.start,
        startLatencyMs: startLatency(own, truth),
        endLatencyMs: endLatency(own, truth),
      });
    }
  }
  const bySource = Object.fromEntries(
    snapshotSourceSchema.options.map((source) => [
      source,
      summarize(rows.filter((r) => r.source === source)),
    ]),
  ) as Record<SnapshotSource, SourceSummary>;
  return { truths, rows, bySource };
}
