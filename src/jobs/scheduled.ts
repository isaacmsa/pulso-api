import { createDb } from '../db/client';
import type { Bindings } from '../env';
import { runRetention } from './retention';

/** La parte de `ScheduledController` que usa el Worker (los tipos de Workers van aparte, ver `tsconfig.worker.json`). */
export type CronController = { cron: string; scheduledTime: number };
export type CronContext = { waitUntil(promise: Promise<unknown>): void };

/** Diario a las 8:00 UTC, las 4:00 a. m. en Caracas (UTC−4 fijo). Tiene que coincidir con `wrangler.jsonc`. */
export const RETENTION_CRON = '0 8 * * *';

/**
 * Los crons del Worker (`triggers.crons` en `wrangler.jsonc`, solo en staging y producción).
 * Reparte por la expresión que disparó la ejecución. Cada ejecución crea su propio cliente de
 * base y lo cierra al terminar: nunca a nivel de módulo (trampa de Hyperdrive).
 */
export async function scheduled(
  controller: CronController,
  env: Bindings,
  _ctx: CronContext,
): Promise<void> {
  if (controller.cron === RETENTION_CRON) {
    const { sql } = createDb(env.HYPERDRIVE.connectionString);
    try {
      const result = await runRetention(sql, controller.scheduledTime);
      console.log(JSON.stringify({ job: 'retention', ...result }));
    } finally {
      await sql.end();
    }
    return;
  }
  console.warn(JSON.stringify({ job: 'unknown-cron', cron: controller.cron }));
}
