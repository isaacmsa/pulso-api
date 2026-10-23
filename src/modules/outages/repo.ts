import type postgres from 'postgres';
import type { OutageStatus } from '../../domain/detection/types';

export type OutageRow = {
  id: string;
  start: number;
  end: number | null;
  status: OutageStatus;
  confidence: 'alta' | 'media' | 'manual';
  confirmed: boolean | null;
};
export type ReportRow = { at: number; value: 'hay_luz' | 'fluctuando' | 'sin_luz' };

type Row = {
  t: 'o' | 'r';
  id: string | null;
  started_at: string | null; // bigint: postgres.js lo devuelve como texto
  ended_at: string | null;
  status: OutageStatus | null;
  confidence: OutageRow['confidence'] | null;
  confirmed: boolean | null;
  at: string | null;
  value: ReportRow['value'] | null;
};

/**
 * Los cortes que se solapan con `[from, to)` y los reportes con `at` en `[from, to)`, de una casa,
 * en **una sola consulta** (un CTE por cada uno, unidos en filas con la marca `t`). Los dos con
 * el más reciente primero. `events_home_at` y `outages_home_started` sirven a los filtros.
 * Sin `jsonb_agg`: Drizzle deja el `jsonb` sin parsear (AGENTS.md).
 */
export async function findOutageHistory(
  sql: postgres.Sql,
  homeId: string,
  range: { from: number; to: number },
): Promise<{ outages: OutageRow[]; reports: ReportRow[] }> {
  const rows = await sql<Row[]>`
    WITH o AS (
      SELECT id, started_at, ended_at, status, confidence, confirmed
      FROM app.outages
      WHERE home_id = ${homeId} AND started_at < ${range.to}
        AND (ended_at IS NULL OR ended_at > ${range.from})
    ), r AS (
      SELECT at, payload->>'value' AS value
      FROM app.events
      WHERE home_id = ${homeId} AND kind = 'report' AND at >= ${range.from} AND at < ${range.to}
    )
    SELECT 'o' AS t, id::text AS id, started_at, ended_at, status, confidence, confirmed,
           NULL::bigint AS at, NULL::text AS value
    FROM o
    UNION ALL
    SELECT 'r', NULL::text, NULL::bigint, NULL::bigint, NULL::text, NULL::text, NULL::boolean,
           at, value
    FROM r
    ORDER BY t, started_at DESC, at DESC`;

  const outages: OutageRow[] = [];
  const reports: ReportRow[] = [];
  for (const row of rows) {
    if (row.t === 'o') {
      outages.push({
        id: row.id as string,
        start: Number(row.started_at),
        end: row.ended_at === null ? null : Number(row.ended_at),
        status: row.status as OutageStatus,
        confidence: row.confidence as OutageRow['confidence'],
        confirmed: row.confirmed,
      });
    } else {
      reports.push({ at: Number(row.at), value: row.value as ReportRow['value'] });
    }
  }
  return { outages, reports };
}
