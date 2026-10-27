import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sendPushes } from '../../src/modules/push/expo';
import {
  clearPushTokens,
  processReceipts,
  RECEIPT_DELAY_MS,
  recordSendResults,
  saveTickets,
  takeDueTickets,
} from '../../src/modules/push/repo';
import { createHome, testDb, truncateAll } from './helpers';

const NOW = 1_800_000_000_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('tickets y recibos de Expo Push', () => {
  const { sql } = testDb();
  let queries = 0;
  const counted = testDb({ onQuery: () => queries++ });

  beforeEach(async () => {
    await truncateAll(sql);
    queries = 0;
  });

  afterAll(async () => {
    await sql.end();
    await counted.sql.end();
  });

  /** Un teléfono con `push_token`. */
  async function phone(token = `ExponentPushToken[${randomUUID()}]`) {
    const { deviceId } = await createHome(sql);
    await sql`UPDATE app.devices SET push_token = ${token} WHERE id = ${deviceId}`;
    return deviceId;
  }

  const tokenOf = async (deviceId: string) =>
    (
      await sql<{ push_token: string | null }[]>`
      SELECT push_token FROM app.devices WHERE id = ${deviceId}`
    )[0]?.push_token;

  const storedTickets = () =>
    sql<{ ticket_id: string; created_at: string }[]>`
      SELECT ticket_id, created_at FROM app.push_tickets ORDER BY ticket_id`;

  /** Un `fetch` que responde a getReceipts con lo que diga `receipts` y cuenta las llamadas. */
  function receiptsFetch(receipts: Record<string, unknown> | 'network-error') {
    const calls: string[][] = [];
    const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const ids = (JSON.parse(String(init?.body)) as { ids: string[] }).ids;
      calls.push(ids);
      if (receipts === 'network-error') throw new TypeError('fetch failed');
      return json({
        data: Object.fromEntries(ids.flatMap((id) => (id in receipts ? [[id, receipts[id]]] : []))),
      });
    }) as typeof fetch;
    return { impl, calls };
  }

  it('saveTickets guarda los tickets en una consulta y ignora un id repetido', async () => {
    const a = await phone();
    const b = await phone();
    await saveTickets(
      counted.sql,
      [
        { ticketId: 't-a', deviceId: a },
        { ticketId: 't-b', deviceId: b },
      ],
      NOW,
    );
    expect(queries).toBe(1);
    await saveTickets(sql, [{ ticketId: 't-a', deviceId: a }], NOW + 1);
    expect((await storedTickets()).map((t) => [t.ticket_id, t.created_at])).toEqual([
      ['t-a', String(NOW)],
      ['t-b', String(NOW)],
    ]);
  });

  it('saveTickets y clearPushTokens sin nada no consultan', async () => {
    await saveTickets(counted.sql, [], NOW);
    await clearPushTokens(counted.sql, []);
    expect(queries).toBe(0);
  });

  it('los tickets de hace menos de 15 min no se leen', async () => {
    const d = await phone();
    await saveTickets(sql, [{ ticketId: 'reciente', deviceId: d }], NOW - RECEIPT_DELAY_MS + 1);
    const { impl, calls } = receiptsFetch({});
    const result = await processReceipts(counted.sql, impl, NOW);
    expect(result).toEqual({ read: 0, cleared: 0, retried: 0 });
    expect(calls).toHaveLength(0);
    expect(queries).toBe(1);
    expect((await storedTickets()).map((t) => t.ticket_id)).toEqual(['reciente']);
    expect(await takeDueTickets(sql, NOW - RECEIPT_DELAY_MS)).toEqual([]);
  });

  it('takeDueTickets devuelve y borra los tickets de 15 min o más', async () => {
    const d = await phone();
    await saveTickets(sql, [{ ticketId: 'vence', deviceId: d }], NOW - RECEIPT_DELAY_MS);
    await saveTickets(sql, [{ ticketId: 'espera', deviceId: d }], NOW);
    expect(await takeDueTickets(sql, NOW - RECEIPT_DELAY_MS)).toEqual([
      { ticketId: 'vence', deviceId: d },
    ]);
    expect((await storedTickets()).map((t) => t.ticket_id)).toEqual(['espera']);
  });

  it('un ticket con DeviceNotRegistered borra el token', async () => {
    const dead = await phone('ExponentPushToken[muerto]');
    const alive = await phone('ExponentPushToken[vivo]');
    const results = await sendPushes(
      [
        { to: 'ExponentPushToken[muerto]', body: 'x', channelId: 'cortes', deviceId: dead },
        { to: 'ExponentPushToken[vivo]', body: 'x', channelId: 'cortes', deviceId: alive },
      ],
      {
        fetch: (async () =>
          json({
            data: [
              { status: 'error', message: 'no', details: { error: 'DeviceNotRegistered' } },
              { status: 'ok', id: 'ticket-vivo' },
            ],
          })) as unknown as typeof fetch,
      },
    );
    expect(await recordSendResults(counted.sql, results, NOW)).toEqual({ saved: 1, cleared: 1 });
    expect(queries).toBe(2);
    expect(await tokenOf(dead)).toBeNull();
    expect(await tokenOf(alive)).toBe('ExponentPushToken[vivo]');
    expect((await storedTickets()).map((t) => t.ticket_id)).toEqual(['ticket-vivo']);
  });

  it('un recibo con DeviceNotRegistered borra el token', async () => {
    const dead = await phone('ExponentPushToken[muerto]');
    const alive = await phone('ExponentPushToken[vivo]');
    await saveTickets(
      sql,
      [
        { ticketId: 't-dead', deviceId: dead },
        { ticketId: 't-alive', deviceId: alive },
      ],
      NOW - RECEIPT_DELAY_MS,
    );
    const { impl, calls } = receiptsFetch({
      't-dead': { status: 'error', message: 'x', details: { error: 'DeviceNotRegistered' } },
      't-alive': { status: 'ok' },
    });
    const result = await processReceipts(counted.sql, impl, NOW, 'secreto');
    expect(result).toEqual({ read: 2, cleared: 1, retried: 0 });
    expect(queries).toBe(2);
    expect(calls).toHaveLength(1);
    expect(await tokenOf(dead)).toBeNull();
    expect(await tokenOf(alive)).toBe('ExponentPushToken[vivo]');
    expect(await storedTickets()).toEqual([]);
  });

  it('un recibo con otro error no borra el token y el ticket se descarta', async () => {
    const d = await phone();
    await saveTickets(sql, [{ ticketId: 't', deviceId: d }], NOW - RECEIPT_DELAY_MS);
    const { impl } = receiptsFetch({
      t: { status: 'error', message: 'x', details: { error: 'MessageRateExceeded' } },
    });
    expect(await processReceipts(sql, impl, NOW)).toEqual({ read: 1, cleared: 0, retried: 0 });
    expect(await tokenOf(d)).not.toBeNull();
    expect(await storedTickets()).toEqual([]);
  });

  it('lee 1500 tickets vencidos en 2 llamadas a Expo', async () => {
    const d = await phone();
    const ids = Array.from({ length: 1500 }, (_, i) => `t-${String(i).padStart(4, '0')}`);
    await saveTickets(
      sql,
      ids.map((ticketId) => ({ ticketId, deviceId: d })),
      NOW - RECEIPT_DELAY_MS,
    );
    const { impl, calls } = receiptsFetch(
      Object.fromEntries(ids.map((id) => [id, { status: 'ok' }])),
    );
    expect(await processReceipts(counted.sql, impl, NOW)).toEqual({
      read: 1500,
      cleared: 0,
      retried: 0,
    });
    expect(calls.map((c) => c.length)).toEqual([1000, 500]);
    expect(queries).toBe(1);
  });

  it('si Expo no responde, los tickets vuelven a la tabla para la próxima vuelta', async () => {
    const d = await phone();
    await saveTickets(sql, [{ ticketId: 't', deviceId: d }], NOW - RECEIPT_DELAY_MS - 5);
    const { impl } = receiptsFetch('network-error');
    expect(await processReceipts(sql, impl, NOW)).toEqual({ read: 1, cleared: 0, retried: 1 });
    expect((await storedTickets()).map((t) => [t.ticket_id, t.created_at])).toEqual([
      ['t', String(NOW)],
    ]);
    // pasados otros 15 min, se leen de nuevo
    const ok = receiptsFetch({ t: { status: 'ok' } });
    expect(await processReceipts(sql, ok.impl, NOW + RECEIPT_DELAY_MS)).toEqual({
      read: 1,
      cleared: 0,
      retried: 0,
    });
    expect(await storedTickets()).toEqual([]);
  });

  it('un ticket de un dispositivo borrado se va con él', async () => {
    const d = await phone();
    await saveTickets(sql, [{ ticketId: 't', deviceId: d }], NOW);
    await sql`DELETE FROM app.devices WHERE id = ${d}`;
    expect(await storedTickets()).toEqual([]);
  });
});
