import type postgres from 'postgres';
import { getReceipts, type SendResult } from './expo';

/** Expo deja leer el recibo unos 15 min después del envío (y lo guarda 24 h). */
export const RECEIPT_DELAY_MS = 15 * 60_000;

export type Ticket = { ticketId: string; deviceId: string };

const DEVICE_NOT_REGISTERED = 'DeviceNotRegistered';

/**
 * Guarda los tickets de un envío, en UNA consulta. Los pasa como un `jsonb` (`JSON.stringify`,
 * no `sql.json()`: ver "Trampas conocidas" de AGENTS.md). Un `ticket_id` repetido se ignora.
 */
export async function saveTickets(
  sql: postgres.Sql,
  tickets: readonly Ticket[],
  now: number,
): Promise<void> {
  if (tickets.length === 0) return;
  await sql`
    INSERT INTO app.push_tickets (ticket_id, device_id, created_at)
    SELECT t.ticket_id, t.device_id, ${now}::bigint
    FROM jsonb_to_recordset(${JSON.stringify(
      tickets.map((t) => ({ ticket_id: t.ticketId, device_id: t.deviceId })),
    )}::jsonb) AS t(ticket_id text, device_id uuid)
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
 * Toma (y borra) los tickets creados en `olderThan` o antes, en UNA consulta
 * (`DELETE … RETURNING`). Quien los toma es responsable de ellos: si no los puede procesar, tiene
 * que volver a guardarlos (`processReceipts` lo hace).
 */
export async function takeDueTickets(sql: postgres.Sql, olderThan: number): Promise<Ticket[]> {
  const rows = await sql<{ ticket_id: string; device_id: string }[]>`
    DELETE FROM app.push_tickets WHERE created_at <= ${olderThan}::bigint
    RETURNING ticket_id, device_id`;
  return rows.map((r) => ({ ticketId: r.ticket_id, deviceId: r.device_id }));
}

/**
 * Lo que hay que hacer con el resultado de `sendPushes`, en 2 consultas como máximo: guardar los
 * tickets que Expo aceptó y borrar el token de los dispositivos a los que respondió
 * `DeviceNotRegistered` en el propio ticket. Los demás errores no se reintentan (el push de un
 * corte ya quedó marcado, regla 11).
 */
export async function recordSendResults(
  sql: postgres.Sql,
  results: readonly SendResult[],
  now: number,
): Promise<{ saved: number; cleared: number }> {
  const tickets = results.flatMap((r) =>
    r.ticketId ? [{ ticketId: r.ticketId, deviceId: r.deviceId }] : [],
  );
  const dead = results.filter((r) => r.error === DEVICE_NOT_REGISTERED).map((r) => r.deviceId);
  await saveTickets(sql, tickets, now);
  const cleared = await clearPushTokens(sql, dead);
  return { saved: tickets.length, cleared };
}

export type ReceiptsResult = {
  /** Tickets que se tomaron de la tabla. */
  read: number;
  /** Tokens borrados por `DeviceNotRegistered` en el recibo. */
  cleared: number;
  /** Tickets devueltos a la tabla porque Expo no respondió (se leen en la próxima vuelta). */
  retried: number;
};

/**
 * Lee los recibos de los tickets de hace 15 min o más y borra los `push_token` con
 * `DeviceNotRegistered`. Lo llama el cron `sweep` (tarea 3.3).
 *
 * Consultas: 1 (`takeDueTickets`) + 1 si hay tokens que borrar. Más 1 solo si Expo falló en
 * algún grupo. Sin tickets vencidos, es 1 sola y no se llama a Expo.
 *
 * Los tickets se borran al tomarlos (`DELETE … RETURNING`) y no después de leer los recibos,
 * para no gastar una consulta más. Si `getReceipts` falla en un grupo, esos tickets se vuelven a
 * guardar con la hora de ahora (esperan otros 15 min; Expo guarda los recibos 24 h). Si el
 * Worker muere entre el `DELETE` y el `INSERT` se pierden esos tickets: lo único que se pierde es
 * limpiar a tiempo un token muerto, que el siguiente push vuelve a descubrir. Un ticket cuyo
 * recibo Expo todavía no tiene (o ya olvidó) se descarta igual.
 */
export async function processReceipts(
  sql: postgres.Sql,
  fetchImpl: typeof fetch,
  now: number,
  accessToken?: string,
): Promise<ReceiptsResult> {
  const due = await takeDueTickets(sql, now - RECEIPT_DELAY_MS);
  if (due.length === 0) return { read: 0, cleared: 0, retried: 0 };

  const receipts = await getReceipts(
    due.map((t) => t.ticketId),
    { fetch: fetchImpl, ...(accessToken ? { accessToken } : {}) },
  );

  const dead = new Set<string>();
  const retry: Ticket[] = [];
  for (const ticket of due) {
    const receipt = receipts[ticket.ticketId];
    if (receipt?.retry) retry.push(ticket);
    else if (receipt?.error === DEVICE_NOT_REGISTERED) dead.add(ticket.deviceId);
  }

  const cleared = await clearPushTokens(sql, [...dead]);
  await saveTickets(sql, retry, now);
  return { read: due.length, cleared, retried: retry.length };
}
