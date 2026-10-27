import type postgres from 'postgres';
import type { StoredOutage } from '../../domain/detection/reconcile';
import type { DetectedOutage, HomeMode } from '../../domain/detection/types';
import type { DeviceEvent } from '../../domain/events/schema';
import type { HomeStatus } from '../../domain/homes/schema';
import type { Notice } from '../push/notices';

export type IngestResult = {
  accepted: number;
  duplicated: number;
  revision: number;
  mode: HomeMode;
  /** Estado de la casa leído con el candado que sube la revisión: más nuevo que el de la auth. */
  status: StatusPair;
  /** Eventos de la ventana de la casa, ordenados por `(at, id)`, con `at` ya corregido. */
  window: DeviceEvent[];
  outages: StoredOutage[];
};

export type IdentifiedChange = { op: 'insert' | 'update'; id: string; outage: DetectedOutage };

export type StatusPair = { state: HomeStatus['state']; since: number };

/**
 * `app.ingest_batch` (docs/data-model.md): guarda el lote sin duplicar y devuelve la ventana y los
 * cortes guardados. Una consulta. Los eventos van como texto JSON con cast implícito a `jsonb`:
 * `sql.json()` no sirve con el cliente de Drizzle (AGENTS.md).
 */
export async function ingestBatch(
  sql: postgres.Sql,
  input: {
    deviceId: string;
    homeId: string;
    events: readonly DeviceEvent[];
    offsetMs: number;
    receivedAt: number;
  },
): Promise<IngestResult> {
  const [row] = await sql<{ result: IngestResult }[]>`
    SELECT app.ingest_batch(
      ${input.deviceId}, ${input.homeId}, ${JSON.stringify(input.events)},
      ${input.offsetMs}, ${input.receivedAt}
    ) AS result`;
  if (!row) throw new Error('ingest_batch no devolvió nada');
  const { result } = row;
  // La ventana ya la validó Zod al entrar: no se vuelve a validar (presupuesto de CPU).
  return {
    ...result,
    outages: result.outages.map(({ id, start, end, status, confidence, confirmed }) => ({
      id,
      start,
      end,
      status,
      confidence,
      confirmed,
    })),
  };
}

export type ApplyResult = {
  applied: boolean;
  status: HomeStatus;
  /** Avisos ya marcados en `outages` en la misma transacción (A-031, regla 11): solo falta mandarlos. */
  notify: Notice[];
};

/**
 * `app.apply_outages`: aplica los cambios y el estado si la revisión no cambió (A-016), marca los
 * avisos de los cortes que se cierran (regreso, resumen tardío, "volvió la luz" de A-034 y
 * confirmación) y devuelve el estado de la casa tal como queda y a quién avisar. Una consulta.
 * `status: null` no escribe el estado.
 */
export async function applyOutages(
  sql: postgres.Sql,
  input: {
    homeId: string;
    revision: number;
    changes: readonly IdentifiedChange[];
    status: StatusPair | null;
    now: number;
  },
): Promise<ApplyResult> {
  const [row] = await sql<{ result: ApplyResult }[]>`
    SELECT app.apply_outages(
      ${input.homeId}, ${input.revision}, ${JSON.stringify(input.changes)},
      ${input.status === null ? null : JSON.stringify(input.status)}, ${input.now}
    ) AS result`;
  if (!row) throw new Error('apply_outages no devolvió nada');
  return row.result;
}
