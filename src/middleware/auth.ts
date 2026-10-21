import type { MiddlewareHandler } from 'hono';
import type postgres from 'postgres';
import type { HomeMode } from '../domain/detection/types';
import type { Diagnostics } from '../domain/events/schema';
import type { HomeStatus } from '../domain/homes/schema';
import type { AppEnv, AuthedDevice } from '../env';
import { sha256Hex } from '../lib/crypto';
import { apiError } from './errors';

const BEARER = /^Bearer +([A-Za-z0-9_-]{43})$/i;

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
 */
export async function authenticate(
  sql: postgres.Sql,
  tokenHash: string,
  now: number,
  diagnostics?: Diagnostics,
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
    )
    SELECT device.id, device.home_id, h.mode, h.status, h.status_since, h.alias,
           open_outage.started_at AS open_outage_start
    FROM device
    LEFT JOIN app.homes h ON h.id = device.home_id
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

/** Lee el `Bearer` y pone `tokenHash`. Sin token responde 401 sin tocar la base. */
export const requireToken: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = BEARER.exec(c.req.header('authorization') ?? '')?.[1];
  if (!token) return invalidToken(c);
  c.set('tokenHash', await sha256Hex(token));
  await next();
};

/** Autentica con `tokenHash` (va después de `requireToken` y del límite) y pone `device`. */
export const requireDevice: MiddlewareHandler<AppEnv> = async (c, next) => {
  const device = await authenticate(c.var.sql, c.var.tokenHash, Date.now());
  if (!device) return invalidToken(c);
  c.set('device', device);
  await next();
};
