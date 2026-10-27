import type { MiddlewareHandler } from 'hono';
import { createDb } from '../db/client';
import type { AppEnv } from '../env';

/**
 * Crea el cliente de la base de cada petición (nunca a nivel de módulo) y lo cierra al final.
 * postgres.js conecta en la primera consulta, así que una ruta que no consulta no conecta.
 *
 * Las tareas de `c.var.defer` (p. ej. mandar los push de un lote) corren después de la respuesta,
 * con `waitUntil`, y el cliente se cierra cuando terminan. En los tests no hay `executionCtx`: la
 * petición las espera antes de responder.
 */
export function withDb(onQuery?: () => void): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { sql, db } = createDb(c.env.HYPERDRIVE.connectionString, { onQuery });
    const deferred: Promise<unknown>[] = [];
    c.set('sql', sql);
    c.set('db', db);
    c.set('defer', (task) => {
      deferred.push(task);
    });
    try {
      await next();
    } finally {
      const closing = Promise.allSettled(deferred).then(() => sql.end());
      const ctx = executionContext(c);
      if (ctx) ctx.waitUntil(closing);
      else await closing;
    }
  };
}

/** En Workers existe; en `app.request()` de los tests no, y leerlo lanza. */
function executionContext(c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }) {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}
