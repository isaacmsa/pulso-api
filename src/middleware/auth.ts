import type { MiddlewareHandler } from 'hono';
import type postgres from 'postgres';
import type { HomeMode } from '../domain/detection/types';
import type { Diagnostics } from '../domain/events/schema';
import type { HomeStatus } from '../domain/homes/schema';
import { EVENTS_RETENTION_MS } from '../domain/retention';
import type { AppEnv, AuthedDevice } from '../env';
import { sha256Hex, verifyToken } from '../lib/crypto';
import { bearerToken } from './bearer';
import { apiError } from './errors';

type AuthRow = {
  id: string;
  home_id: string | null;
  mode: HomeMode | null;
  status: HomeStatus['state'] | null;
  status_since: string | null; // bigint: postgres.js lo devuelve como texto
  alias: string | null;
  open_outage_start: string | null;
};

/**
 * Autentica y registra el latido en **una sola consulta** (A-004): el `UPDATE … RETURNING` de
 * `devices`, la casa y su corte abierto. Con `diagnostics` también los guarda.
 *
 * Con `revive` (por defecto `false`; solo un `POST /v1/events` vacío, el latido, lo pasa en `true`),
 * si la casa del dispositivo estaba en `sin_noticias` (el cron `sweep`) y no tiene corte abierto, la
 * misma consulta la devuelve a `con_luz` desde `now` y sube su revisión (A-037, A-023). No la
 * devuelve si su corte más reciente está `sin_datos` (y empezó hace 30 días o menos): el teléfono
 * estuvo callado durante un corte y vuelve sin cambios, así que la luz sigue sin volver; el `sweep`
 * lo reabre (A-049). Las demás rutas y un lote con eventos no la devuelven: lo decide la
 * clasificación, que sabe cuándo volvió la luz. Solo la casa del propio dispositivo: un seguidor no
 * tiene `home_id` y no toca ninguna. Los cortes no se escriben aquí (orden de candados: casa y luego cortes). El
 * `SELECT` final no ve lo que escribe el CTE, así que el estado sale de su `RETURNING`.
 */
export async function authenticate(
  sql: postgres.Sql,
  tokenHash: string,
  now: number,
  diagnostics?: Diagnostics,
  { revive = false }: { revive?: boolean } = {},
): Promise<AuthedDevice | null> {
  // jsonb como texto con cast: sql.json() no sirve con el cliente de Drizzle (AGENTS.md)
  const setDiagnostics = diagnostics
    ? sql`, diagnostics = ${JSON.stringify(diagnostics)}::jsonb`
    : sql``;
  const [row] = await sql<AuthRow[]>`
    WITH device AS (
      UPDATE app.devices SET last_seen_at = ${now} ${setDiagnostics}
      WHERE token_hash = ${tokenHash}
      RETURNING id, home_id
    ),
    revived AS (
      UPDATE app.homes AS h
      SET status = 'con_luz', status_since = ${now}, ingest_revision = h.ingest_revision + 1
      FROM device
      WHERE ${revive}::boolean
        AND h.id = device.home_id
        AND h.status = 'sin_noticias'
        AND NOT EXISTS (
          SELECT 1 FROM app.outages o WHERE o.home_id = h.id AND o.status = 'abierto'
        )
        AND NOT EXISTS (
          SELECT 1 FROM (
            SELECT o.status, o.started_at FROM app.outages o
            WHERE o.home_id = h.id
            ORDER BY o.started_at DESC, o.id DESC
            LIMIT 1
          ) latest
          WHERE latest.status = 'sin_datos' AND latest.started_at >= ${now - EVENTS_RETENTION_MS}
        )
      RETURNING h.id, h.status, h.status_since
    )
    SELECT device.id, device.home_id, h.mode,
           coalesce(revived.status, h.status) AS status,
           coalesce(revived.status_since, h.status_since) AS status_since,
           h.alias, open_outage.started_at AS open_outage_start
    FROM device
    LEFT JOIN app.homes h ON h.id = device.home_id
    LEFT JOIN revived ON revived.id = device.home_id
    LEFT JOIN LATERAL (
      SELECT o.started_at FROM app.outages o
      WHERE o.home_id = device.home_id AND o.status = 'abierto'
      ORDER BY o.started_at DESC
      LIMIT 1
    ) open_outage ON true`;
  if (!row) return null;
  return {
    id: row.id,
    homeId: row.home_id,
    home:
      row.home_id && row.mode && row.status && row.status_since !== null && row.alias !== null
        ? {
            mode: row.mode,
            state: row.status,
            since: Number(row.status_since),
            alias: row.alias,
            openOutageStart: row.open_outage_start === null ? null : Number(row.open_outage_start),
          }
        : null,
  };
}

function invalidToken(c: Parameters<MiddlewareHandler<AppEnv>>[0]) {
  return apiError(c, 401, 'invalid_token', 'El token falta o no es válido.');
}

/**
 * Lee el `Bearer`, verifica su firma y pone `tokenHash` (el SHA-256 del token completo). Un token
 * ausente, mal formado o con firma inválida responde 401 sin tocar la base ni el límite.
 */
export const requireToken: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearerToken(c.req.header('authorization'));
  if (!token || !(await verifyToken(c.env.TOKEN_SIGNING_KEY, token))) return invalidToken(c);
  c.set('tokenHash', await sha256Hex(token));
  await next();
};

/** Autentica con `tokenHash` (va después de `requireToken` y del límite) y pone `device`. */
export const requireDevice: MiddlewareHandler<AppEnv> = async (c, next) => {
  const device = await authenticate(c.var.sql, c.var.tokenHash, c.var.now());
  if (!device) return invalidToken(c);
  c.set('device', device);
  await next();
};
