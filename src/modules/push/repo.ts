import type postgres from 'postgres';
import { MIN_OUTAGE_MS } from '../../domain/detection/constants';
import { getReceipts, type SendResult } from './expo';
import type { Notice } from './notices';

/** Expo deja leer el recibo unos 15 min después del envío (y lo guarda 24 h). */
export const RECEIPT_DELAY_MS = 15 * 60_000;

/** Expo guarda los recibos 24 h: pasado ese plazo, leer un ticket ya no sirve. */
export const RECEIPT_TTL_MS = 24 * 60 * 60_000;

export type Ticket = { ticketId: string; deviceId: string };
export type StoredTicket = Ticket & { createdAt: number };

const DEVICE_NOT_REGISTERED = 'DeviceNotRegistered';

/** A-033: el push de inicio sale solo si el servidor conoce el corte desde hace 30 min o menos. */
export const START_PUSH_WINDOW_MS = 30 * 60_000;

/**
 * Reclama los push de inicio (docs/api.md, "Cuándo sale cada push"), en UNA consulta: marca
 * `start_notified_at` en cada corte `abierto` de `MIN_OUTAGE_MS` o más, sin marca y conocido hace
 * 30 min o menos (`created_at`, A-033), y devuelve los seguidores con `push_token` de esas casas.
 *
 * Regla 11: `UPDATE … WHERE start_notified_at IS NULL RETURNING`. Si dos `sweep` (o un `sweep` y
 * el lote que cierra el corte) llegan a la vez, el candado de la fila hace que el segundo vuelva a
 * evaluar el `WHERE` con la fila ya cambiada: solo uno marca, y un corte que se cerró entretanto
 * deja de estar `abierto`. Un corte sin seguidores con token queda marcado y no devuelve nada. Un
 * token repetido (dos registros con el mismo) recibe una sola vez.
 */
export async function claimStartPushes(sql: postgres.Sql, now: number): Promise<Notice[]> {
  const rows = await sql<
    {
      outage_id: string;
      home_id: string;
      started_at: string;
      home_alias: string;
      device_id: string;
      push_token: string;
      alias: string;
    }[]
  >`
    WITH claimed AS (
      UPDATE app.outages
      SET start_notified_at = ${now}::bigint
      WHERE status = 'abierto'
        AND start_notified_at IS NULL
        AND started_at <= ${now - MIN_OUTAGE_MS}::bigint
        AND created_at >= ${now - START_PUSH_WINDOW_MS}::bigint
      RETURNING id, home_id, started_at
    )
    SELECT c.id AS outage_id, c.home_id, c.started_at, h.alias AS home_alias, t.device_id, t.push_token, t.alias
    FROM claimed c
    JOIN app.homes h ON h.id = c.home_id
    JOIN LATERAL (
      SELECT DISTINCT ON (d.push_token) d.id AS device_id, d.push_token, f.alias
      FROM app.follows f
      JOIN app.devices d ON d.id = f.follower_device_id
      WHERE f.home_id = c.home_id AND d.push_token IS NOT NULL
      ORDER BY d.push_token, f.created_at, d.id
    ) t ON true
    ORDER BY c.home_id, c.started_at`;

  const notices = new Map<string, Notice>();
  for (const row of rows) {
    let notice = notices.get(row.outage_id);
    if (!notice) {
      notice = {
        kind: 'start',
        homeId: row.home_id,
        outageStart: Number(row.started_at),
        outageEnd: null,
        alias: row.home_alias,
        targets: [],
      };
      notices.set(row.outage_id, notice);
    }
    notice.targets.push({ deviceId: row.device_id, pushToken: row.push_token, alias: row.alias });
  }
  return [...notices.values()];
}

/**
 * Guarda los tickets de un envío, en UNA consulta. Los pasa como un `jsonb` (`JSON.stringify`,
 * no `sql.json()`: ver "Trampas conocidas" de AGENTS.md). Un `ticket_id` repetido se ignora.
 * `created_at` es `now`, salvo en un ticket que vuelve con su `createdAt` original. El `JOIN` con
 * `devices` omite los tickets de un dispositivo que se borró entre el envío y este guardado: sin
 * él, la llave foránea haría fallar el `INSERT` entero y se perderían también los demás tickets.
 */
export async function saveTickets(
  sql: postgres.Sql,
  tickets: readonly (Ticket & { createdAt?: number })[],
  now: number,
): Promise<void> {
  if (tickets.length === 0) return;
  await sql`
    INSERT INTO app.push_tickets (ticket_id, device_id, created_at)
    SELECT t.ticket_id, t.device_id, t.created_at
    FROM jsonb_to_recordset(${JSON.stringify(
      tickets.map((t) => ({
        ticket_id: t.ticketId,
        device_id: t.deviceId,
        created_at: t.createdAt ?? now,
      })),
    )}::jsonb) AS t(ticket_id text, device_id uuid, created_at bigint)
    JOIN app.devices d ON d.id = t.device_id
    ON CONFLICT (ticket_id) DO NOTHING`;
}

/** Borra el `push_token` de esos dispositivos (Expo dijo `DeviceNotRegistered`), en UNA consulta. */
export async function clearPushTokens(
  sql: postgres.Sql,
  deviceIds: readonly string[],
): Promise<number> {
  if (deviceIds.length === 0) return 0;
  const rows = await sql`
    UPDATE app.devices SET push_token = NULL
    WHERE id IN ${sql(deviceIds as string[])} AND push_token IS NOT NULL
    RETURNING id`;
  return rows.length;
}

/**
 * Renueva `last_seen_at` de esos dispositivos, en UNA consulta, solo si únicamente siguen casas
 * (`home_id IS NULL`, A-047): el `last_seen_at` del teléfono de una casa es su latido, y de él salen
 * "sin noticias" y `sin_datos` (A-037, A-049). Nunca lo retrasa (`GREATEST`): un latido o una
 * petición más nueva que `now` se respeta.
 */
export async function touchDevices(
  sql: postgres.Sql,
  deviceIds: readonly string[],
  now: number,
): Promise<void> {
  if (deviceIds.length === 0) return;
  await sql`
    UPDATE app.devices SET last_seen_at = GREATEST(last_seen_at, ${now}::bigint)
    WHERE id IN ${sql(deviceIds as string[])} AND home_id IS NULL`;
}

/**
 * Borra el `push_token` solo donde todavía es el token al que se mandó (`to`), en UNA consulta:
 * si el teléfono se registró con otro token después del envío, el nuevo se queda.
 */
export async function clearStaleTokens(
  sql: postgres.Sql,
  sent: readonly { deviceId: string; to: string }[],
): Promise<number> {
  if (sent.length === 0) return 0;
  const rows = await sql`
    UPDATE app.devices d SET push_token = NULL
    FROM jsonb_to_recordset(${JSON.stringify(
      sent.map((s) => ({ device_id: s.deviceId, token: s.to })),
    )}::jsonb) AS s(device_id uuid, token text)
    WHERE d.id = s.device_id AND d.push_token = s.token
    RETURNING d.id`;
  return rows.length;
}

/** Cuenta cuántas veces sale cada código de error (nunca tokens ni ids). */
function countErrors(codes: Iterable<string | undefined>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const code of codes) {
    if (code && code !== DEVICE_NOT_REGISTERED) counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}

/**
 * Toma (y borra) los tickets creados en `olderThan` o antes, en UNA consulta
 * (`DELETE … RETURNING`). Quien los toma es responsable de ellos: si no los puede procesar, tiene
 * que volver a guardarlos (`processReceipts` lo hace).
 */
export async function takeDueTickets(
  sql: postgres.Sql,
  olderThan: number,
): Promise<StoredTicket[]> {
  const rows = await sql<{ ticket_id: string; device_id: string; created_at: string }[]>`
    DELETE FROM app.push_tickets WHERE created_at <= ${olderThan}::bigint
    RETURNING ticket_id, device_id, created_at`;
  return rows.map((r) => ({
    ticketId: r.ticket_id,
    deviceId: r.device_id,
    createdAt: Number(r.created_at),
  }));
}

/**
 * Lo que hay que hacer con el resultado de `sendPushes`, en 2 consultas como máximo: guardar los
 * tickets que Expo aceptó y borrar el token de los dispositivos a los que respondió
 * `DeviceNotRegistered` en el propio ticket (solo si el token sigue siendo al que se mandó). Los
 * demás errores no se reintentan (el push de un corte ya quedó marcado, regla 11): se devuelven
 * contados por código en `errors` para que quien llama los registre.
 */
export async function recordSendResults(
  sql: postgres.Sql,
  results: readonly SendResult[],
  now: number,
): Promise<{ saved: number; cleared: number; errors: Record<string, number> }> {
  const tickets = results.flatMap((r) =>
    r.ticketId ? [{ ticketId: r.ticketId, deviceId: r.deviceId }] : [],
  );
  const dead = results.filter((r) => r.error === DEVICE_NOT_REGISTERED);
  await saveTickets(sql, tickets, now);
  const cleared = await clearStaleTokens(sql, dead);
  return { saved: tickets.length, cleared, errors: countErrors(results.map((r) => r.error)) };
}

export type ReceiptsResult = {
  /** Tickets que se tomaron de la tabla (incluye los vencidos de 24 h). */
  read: number;
  /** Tokens borrados por `DeviceNotRegistered` en el recibo. */
  cleared: number;
  /** Tickets devueltos a la tabla porque Expo no respondió o respondió algo ilegible. */
  retried: number;
  /** Tickets de más de 24 h: se descartaron sin preguntar a Expo. */
  expired: number;
  /** Errores de recibo (y de la llamada) por código, salvo `DeviceNotRegistered`. Sin tokens. */
  errors: Record<string, number>;
};

/**
 * Lee los recibos de los tickets de hace 15 min o más y borra los `push_token` con
 * `DeviceNotRegistered`. Lo llama el cron `sweep` (tarea 3.3), que registra `errors`.
 *
 * Un recibo `ok` renueva el `last_seen_at` de su dispositivo (A-045): un familiar que solo recibe
 * avisos no hace peticiones, y sin esto la retención de 180 días lo borraría estando vivo.
 *
 * Consultas: 1 (`takeDueTickets`) + 1 si hay tokens que borrar + 1 si algún recibo fue `ok`. Más 1
 * solo si hay tickets que reintentar. Sin tickets vencidos, es 1 sola y no se llama a Expo.
 *
 * Los tickets se borran al tomarlos (`DELETE … RETURNING`) y no después de leer los recibos,
 * para no gastar una consulta más. Si `getReceipts` falla en un grupo (o devuelve un recibo
 * ilegible), esos tickets se vuelven a guardar **con su `created_at` original**: el siguiente
 * `sweep` los lee otra vez, y cuando pasan de 24 h (lo que Expo guarda los recibos) se descartan
 * como `expired`, así un error permanente (p. ej. un 401) no los deja dando vueltas para siempre.
 * Si el Worker muere entre el `DELETE` y el `INSERT` se pierden esos tickets: lo único que se
 * pierde es limpiar a tiempo un token muerto, que el siguiente push vuelve a descubrir. Un ticket
 * cuyo recibo Expo todavía no tiene (o ya olvidó) se descarta igual.
 */
export async function processReceipts(
  sql: postgres.Sql,
  fetchImpl: typeof fetch,
  now: number,
  accessToken?: string,
): Promise<ReceiptsResult> {
  const due = await takeDueTickets(sql, now - RECEIPT_DELAY_MS);
  if (due.length === 0) return { read: 0, cleared: 0, retried: 0, expired: 0, errors: {} };

  const live = due.filter((t) => t.createdAt >= now - RECEIPT_TTL_MS);
  const expired = due.length - live.length;
  if (live.length === 0) return { read: due.length, cleared: 0, retried: 0, expired, errors: {} };

  const receipts = await getReceipts(
    live.map((t) => t.ticketId),
    { fetch: fetchImpl, ...(accessToken ? { accessToken } : {}) },
  );

  const dead = new Set<string>();
  const received = new Set<string>();
  const retry: StoredTicket[] = [];
  for (const ticket of live) {
    const receipt = receipts[ticket.ticketId];
    if (receipt?.retry) retry.push(ticket);
    else if (receipt?.error === DEVICE_NOT_REGISTERED) dead.add(ticket.deviceId);
    else if (receipt?.status === 'ok') received.add(ticket.deviceId);
  }

  const cleared = await clearPushTokens(sql, [...dead]);
  await touchDevices(sql, [...received], now);
  await saveTickets(sql, retry, now);
  return {
    read: due.length,
    cleared,
    retried: retry.length,
    expired,
    errors: countErrors(live.map((t) => receipts[t.ticketId]?.error)),
  };
}
