import type postgres from 'postgres';
import { createDb } from '../db/client';
import type { Bindings } from '../env';
import { type SendSummary, sendAndRecord } from '../modules/push/notices';
import { claimStartPushes, processReceipts, type ReceiptsResult } from '../modules/push/repo';

export type SweepDeps = {
  /** El `fetch` con el que se habla con Expo (por defecto el global; en los tests, uno falso). */
  fetch?: typeof fetch;
  /** Se llama una vez por consulta (para contarlas en los tests). */
  onQuery?: () => void;
};

export type StaleResult = {
  /** Casas que pasaron a `sin_noticias` en esta pasada. */
  noNews: number;
  /** Cortes que pasaron de `abierto` a `sin_datos` en esta pasada. */
  noData: number;
};

export type SweepResult = {
  /** Cortes que recibieron su push de inicio en esta pasada (con al menos un destinatario). */
  starts: number;
  push: SendSummary;
  receipts: ReceiptsResult;
  stale: StaleResult;
};

/**
 * `app.mark_stale` (A-037, A-038), una consulta: deja en `sin_datos` los cortes `abierto` de las
 * casas sin eventos nuevos desde hace 24 h y en `sin_noticias` las casas sin corte abierto cuyo
 * teléfono no tiene latido desde hace 40 min, y sube la revisión de cada casa que toca (A-023).
 */
export async function markStale(sql: postgres.Sql, now: number): Promise<StaleResult> {
  const [row] = await sql<{ result: StaleResult }[]>`SELECT app.mark_stale(${now}) AS result`;
  if (!row) throw new Error('mark_stale no devolvió nada');
  return row.result;
}

/**
 * El cron `sweep` (cada 5 min): reclama y manda los push de inicio, lee los recibos de Expo y
 * borra los `push_token` muertos, y al final marca "sin noticias" y `sin_datos` (`markStale`).
 * Crea su propio cliente de base y lo cierra al terminar.
 *
 * Consultas: 1 (`claimStartPushes`) + 1 si salió algún push (tickets) + 1 (`processReceipts`, que
 * gasta más solo si hay recibos que leer) + 1 (`markStale`). Sin nada que hacer, 3 por pasada,
 * ~864 al día en total.
 */
export async function runSweep(
  env: Bindings,
  now: number,
  deps: SweepDeps = {},
): Promise<SweepResult> {
  // sin `this`: el `fetch` global de Workers lanza "Illegal invocation" como método de otro objeto
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  const expo = {
    fetch: fetchImpl,
    ...(env.EXPO_ACCESS_TOKEN ? { accessToken: env.EXPO_ACCESS_TOKEN } : {}),
  };
  const { sql } = createDb(
    env.HYPERDRIVE.connectionString,
    deps.onQuery ? { onQuery: deps.onQuery } : {},
  );
  try {
    const starts = await claimStartPushes(sql, now);
    const push = await sendAndRecord(sql, starts, now, expo);
    const receipts = await processReceipts(sql, fetchImpl, now, env.EXPO_ACCESS_TOKEN);
    if (Object.keys(receipts.errors).length > 0) {
      console.error(JSON.stringify({ job: 'sweep', receiptErrors: receipts.errors }));
    }
    // al final: un fallo aquí no frena los avisos de la pasada
    const stale = await markStale(sql, now);
    return { starts: starts.length, push, receipts, stale };
  } finally {
    // un fallo al cerrar no debe tapar el error de la pasada
    await sql.end().catch(() => {});
  }
}
