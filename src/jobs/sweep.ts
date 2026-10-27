import { createDb } from '../db/client';
import type { Bindings } from '../env';
import { type SendSummary, sendAndRecord } from '../modules/push/notices';
import { claimStartPushes, processReceipts, type ReceiptsResult } from '../modules/push/repo';

export type SweepDeps = {
  /** El `fetch` con el que se habla con Expo (por defecto el global; en los tests, uno falso). */
  fetch?: typeof fetch;
};

export type SweepResult = {
  /** Cortes que recibieron su push de inicio en esta pasada (con al menos un destinatario). */
  starts: number;
  push: SendSummary;
  receipts: ReceiptsResult;
};

/**
 * El cron `sweep` (cada 5 min): reclama y manda los push de inicio, y después lee los recibos de
 * Expo y borra los `push_token` muertos. Crea su propio cliente de base y lo cierra al terminar.
 *
 * Consultas: 1 (`claimStartPushes`) + 1 si salió algún push (tickets) + 1 (`processReceipts`, que
 * gasta más solo si hay tickets vencidos). Sin nada que hacer, 2 por pasada, ~576 al día.
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
  const { sql } = createDb(env.HYPERDRIVE.connectionString);
  try {
    const starts = await claimStartPushes(sql, now);
    const push = await sendAndRecord(sql, starts, now, expo);
    const receipts = await processReceipts(sql, fetchImpl, now, env.EXPO_ACCESS_TOKEN);
    if (Object.keys(receipts.errors).length > 0) {
      console.error(JSON.stringify({ job: 'sweep', receiptErrors: receipts.errors }));
    }
    return { starts: starts.length, push, receipts };
  } finally {
    // un fallo al cerrar no debe tapar el error de la pasada
    await sql.end().catch(() => {});
  }
}
