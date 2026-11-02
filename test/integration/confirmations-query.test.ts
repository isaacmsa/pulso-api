import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHome, testDb, truncateAll } from './helpers';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const QUERY = readFileSync(
  new URL('../../scripts/spike/confirmations.sql', import.meta.url),
  'utf8',
);

type Export = {
  exportedAt: number;
  homes: {
    home: number;
    outages: {
      start: number;
      end: number | null;
      status: string;
      confidence: string;
      confirmed: boolean | null;
      events: { kind: string; at: number }[];
    }[];
    reports: { kind: string; at: number }[];
  }[];
};

describe('la consulta de confirmaciones (tarea 4.4)', () => {
  const { sql } = testDb();
  // La consulta usa now(): los datos se ponen alrededor de la hora real
  const now = Date.now();

  beforeEach(async () => {
    await truncateAll(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  async function insertEvent(
    deviceId: string,
    homeId: string,
    at: number,
    payload: Record<string, unknown>,
  ) {
    const id = randomUUID();
    await sql`
      INSERT INTO app.events (device_id, id, home_id, kind, device_at, at, payload, received_at)
      VALUES (${deviceId}, ${id}, ${homeId}, ${payload.kind as string}, ${at - 1000}, ${at},
              ${JSON.stringify({ id, at: at - 1000, ...payload })}::jsonb, ${at})`;
  }

  async function insertOutage(
    homeId: string,
    start: number,
    end: number | null,
    confirmed: boolean | null,
  ) {
    await sql`
      INSERT INTO app.outages (id, home_id, started_at, ended_at, status, confidence, confirmed, updated_at)
      VALUES (${randomUUID()}, ${homeId}, ${start}, ${end}, ${end === null ? 'abierto' : 'cerrado'},
              'alta', ${confirmed}, ${now})`;
  }

  async function run(): Promise<Export> {
    const [row] = await sql.unsafe<{ export: Export }[]>(QUERY);
    if (!row) throw new Error('la consulta no devolvió fila');
    return row.export;
  }

  it('trae los cortes de 30 días con su ventana, sin ids, y los botones de cada casa', async () => {
    const first = await createHome(sql, { since: now - 40 * DAY });
    const second = await createHome(sql, { since: now - 20 * DAY });
    const start = now - 5 * DAY;
    const end = start + 3 * HOUR;
    await insertOutage(first.homeId, now - 31 * DAY, now - 31 * DAY + HOUR, null); // fuera de los 30 días
    await insertOutage(first.homeId, start, end, false);
    await insertEvent(first.deviceId, first.homeId, start - 3 * HOUR, { kind: 'snapshot' }); // fuera del margen
    await insertEvent(first.deviceId, first.homeId, start - HOUR, { kind: 'snapshot' });
    await insertEvent(first.deviceId, first.homeId, end + HOUR, {
      kind: 'confirmation',
      outageStart: start,
      answer: false,
    });
    await insertEvent(second.deviceId, second.homeId, now - 2 * DAY, {
      kind: 'report',
      value: 'sin_luz',
    });

    const result = await run();

    expect(Math.abs(result.exportedAt - Date.now())).toBeLessThan(60_000);
    expect(result.homes.map((h) => h.home)).toEqual([1, 2]);
    const [home1, home2] = result.homes;
    expect(home1?.outages).toHaveLength(1);
    expect(home1?.outages[0]).toMatchObject({ start, end, status: 'cerrado', confirmed: false });
    // los eventos llevan el `at` corregido, no el del teléfono
    expect(home1?.outages[0]?.events.map((e) => [e.kind, e.at])).toEqual([
      ['snapshot', start - HOUR],
      ['confirmation', end + HOUR],
    ]);
    expect(home1?.reports.map((e) => e.kind)).toEqual(['confirmation']);
    expect(home2?.outages).toEqual([]);
    expect(home2?.reports.map((e) => e.kind)).toEqual(['report']);
    // ningún id de casa ni de dispositivo en el JSON
    const text = JSON.stringify(result);
    for (const id of [first.homeId, first.deviceId, second.homeId, second.deviceId]) {
      expect(text).not.toContain(id);
    }
  });

  it('un corte abierto trae los eventos hasta ahora', async () => {
    const { homeId, deviceId } = await createHome(sql, { since: now - 10 * DAY });
    const start = now - 4 * HOUR;
    await insertOutage(homeId, start, null, null);
    await insertEvent(deviceId, homeId, now - HOUR, { kind: 'snapshot' });

    const result = await run();

    expect(result.homes[0]?.outages[0]).toMatchObject({
      start,
      end: null,
      status: 'abierto',
      confirmed: null,
    });
    expect(result.homes[0]?.outages[0]?.events).toHaveLength(1);
  });

  it('deja fuera un corte cuyo margen de 2 h ya cae antes de los 30 días', async () => {
    const { homeId } = await createHome(sql, { since: now - 40 * DAY });
    await insertOutage(homeId, now - 30 * DAY + HOUR, now - 30 * DAY + 2 * HOUR, null);

    expect((await run()).homes[0]?.outages).toEqual([]);
  });

  it('un corte sin fin trae a lo sumo 48 h de eventos desde su inicio', async () => {
    const { homeId, deviceId } = await createHome(sql, { since: now - 10 * DAY });
    const start = now - 5 * DAY;
    await insertOutage(homeId, start, null, null);
    await insertEvent(deviceId, homeId, start + HOUR, { kind: 'snapshot' });
    await insertEvent(deviceId, homeId, start + 3 * DAY, { kind: 'snapshot' }); // fuera del tope

    const events = (await run()).homes[0]?.outages[0]?.events ?? [];
    expect(events.map((e) => e.at)).toEqual([start + HOUR]);
  });

  it('sin casas devuelve una lista vacía', async () => {
    expect((await run()).homes).toEqual([]);
  });
});
