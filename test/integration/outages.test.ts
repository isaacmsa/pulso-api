import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Bindings, RateLimiter } from '../../src/env';
import { createApp } from '../../src/index';
import { TEST_SIGNING_KEY, testDb, truncateAll } from './helpers';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;
// lunes 19 de octubre de 2026, 00:00 en Caracas (UTC−4)
const FROM = Date.UTC(2026, 9, 19, 4);
const TO = FROM + 7 * DAY;
const MAX_SPAN = 92 * DAY;

const limiter: RateLimiter = { limit: async () => ({ success: true }) };

function testEnv(): Bindings {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('Falta TEST_DATABASE_URL');
  return {
    HYPERDRIVE: { connectionString: url },
    RATE_LIMIT_REGISTER: limiter,
    RATE_LIMIT_EVENTS: limiter,
    RATE_LIMIT_API: limiter,
    RATE_LIMIT_PUBLIC: limiter,
    ENVIRONMENT: 'test',
    TOKEN_SIGNING_KEY: TEST_SIGNING_KEY,
  };
}

type OutageBody = {
  items: {
    id: string;
    start: number;
    end: number | null;
    status: string;
    confidence: string;
    confirmed: boolean | null;
  }[];
  reports: { at: number; value: string }[];
  totalMs: number;
  days: { date: string; ms: number }[];
};

describe('GET /v1/homes/me/outages', () => {
  const { sql } = testDb();
  let queries = 0;
  let now = TO;
  const app = createApp({ onQuery: () => queries++, now: () => now });

  beforeEach(async () => {
    await truncateAll(sql);
    queries = 0;
    now = TO;
  });

  afterAll(async () => {
    await sql.end();
  });

  function call(path: string, token?: string, method = 'GET') {
    return app.request(
      path,
      { method, headers: token ? { Authorization: `Bearer ${token}` } : {} },
      testEnv(),
    );
  }

  async function register(withHome: boolean) {
    const reg = await app.request(
      '/v1/devices',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appVersion: '1.0.0' }),
      },
      testEnv(),
    );
    const device = (await reg.json()) as { deviceId: string; token: string };
    let homeId = '';
    if (withHome) {
      const res = await app.request(
        '/v1/homes',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${device.token}`,
            'content-type': 'application/json',
          },
          body: '{}',
        },
        testEnv(),
      );
      expect(res.status).toBe(201);
      homeId = ((await res.json()) as { homeId: string }).homeId;
    }
    queries = 0;
    return { ...device, homeId };
  }

  async function addOutage(
    homeId: string,
    o: {
      start: number;
      end: number | null;
      status?: string;
      confidence?: string;
      confirmed?: boolean | null;
    },
  ) {
    const id = randomUUID();
    await sql`
      INSERT INTO app.outages (id, home_id, started_at, ended_at, status, confidence, confirmed, updated_at)
      VALUES (${id}, ${homeId}, ${o.start}, ${o.end}, ${o.status ?? 'cerrado'},
              ${o.confidence ?? 'alta'}, ${o.confirmed ?? null}, ${o.start})`;
    return id;
  }

  async function addReport(
    deviceId: string,
    homeId: string,
    at: number,
    value: 'hay_luz' | 'fluctuando' | 'sin_luz',
  ) {
    const id = randomUUID();
    const payload = JSON.stringify({ kind: 'report', id, value });
    await sql`
      INSERT INTO app.events (device_id, id, home_id, kind, device_at, at, payload, received_at)
      VALUES (${deviceId}, ${id}, ${homeId}, 'report', ${at}, ${at}, ${payload}::jsonb, ${at})`;
  }

  const range = (from = FROM, to = TO) => `/v1/homes/me/outages?from=${from}&to=${to}`;

  async function getOk(token: string, path = range()) {
    const res = await call(path, token);
    expect(res.status).toBe(200);
    return (await res.json()) as OutageBody;
  }

  it('trae los cortes que se solapan con el rango, también los descartados', async () => {
    const { token, homeId } = await register(true);
    const closed = await addOutage(homeId, {
      start: FROM + 10 * HOUR,
      end: FROM + 12 * HOUR,
      confirmed: true,
    });
    const discarded = await addOutage(homeId, {
      start: FROM + 2 * DAY,
      end: FROM + 2 * DAY + 30 * MIN,
      status: 'descartado',
      confidence: 'media',
      confirmed: false,
    });
    // fuera del rango: antes, justo terminando en `from`, justo empezando en `to` y después
    await addOutage(homeId, { start: FROM - 3 * HOUR, end: FROM - HOUR });
    await addOutage(homeId, { start: FROM - 3 * HOUR, end: FROM });
    await addOutage(homeId, { start: TO, end: TO + HOUR });
    await addOutage(homeId, { start: TO + DAY, end: null, status: 'abierto' });

    const body = await getOk(token);

    expect(body.items).toEqual([
      {
        id: discarded,
        start: FROM + 2 * DAY,
        end: FROM + 2 * DAY + 30 * MIN,
        status: 'descartado',
        confidence: 'media',
        confirmed: false,
      },
      {
        id: closed,
        start: FROM + 10 * HOUR,
        end: FROM + 12 * HOUR,
        status: 'cerrado',
        confidence: 'alta',
        confirmed: true,
      },
    ]);
    expect(body.totalMs).toBe(2 * HOUR); // el descartado no suma
  });

  it('un corte que empezó antes del rango cuenta solo lo que cae dentro', async () => {
    const { token, homeId } = await register(true);
    await addOutage(homeId, { start: FROM - HOUR, end: FROM + 2 * HOUR });

    const body = await getOk(token);

    expect(body.items).toHaveLength(1);
    expect(body.totalMs).toBe(2 * HOUR);
  });

  it('un corte abierto cuenta hasta now', async () => {
    const { token, homeId } = await register(true);
    now = FROM + 3 * DAY + 5 * HOUR;
    const open = await addOutage(homeId, {
      start: FROM + 3 * DAY + 2 * HOUR,
      end: null,
      status: 'abierto',
      confidence: 'media',
    });

    const body = await getOk(token);

    expect(body.items).toEqual([
      {
        id: open,
        start: FROM + 3 * DAY + 2 * HOUR,
        end: null,
        status: 'abierto',
        confidence: 'media',
        confirmed: null,
      },
    ]);
    expect(body.totalMs).toBe(3 * HOUR);

    now += HOUR;
    expect((await getOk(token)).totalMs).toBe(4 * HOUR);
  });

  it('reparte por día en Caracas, con los 7 días de la semana incluidos los que van en 0', async () => {
    const { token, homeId } = await register(true);
    // de las 11 p. m. del martes a la 1 a. m. del miércoles, hora de Caracas
    await addOutage(homeId, { start: FROM + DAY + 23 * HOUR, end: FROM + 2 * DAY + HOUR });

    const body = await getOk(token);

    expect(body.days).toEqual([
      { date: '2026-10-19', ms: 0 },
      { date: '2026-10-20', ms: HOUR },
      { date: '2026-10-21', ms: HOUR },
      { date: '2026-10-22', ms: 0 },
      { date: '2026-10-23', ms: 0 },
      { date: '2026-10-24', ms: 0 },
      { date: '2026-10-25', ms: 0 },
    ]);
    expect(body.totalMs).toBe(2 * HOUR);
  });

  it('trae los reportes del rango, incluido fluctuando', async () => {
    const { token, deviceId, homeId } = await register(true);
    await addReport(deviceId, homeId, FROM - 1, 'sin_luz'); // antes del rango
    await addReport(deviceId, homeId, FROM, 'hay_luz'); // `from` entra
    await addReport(deviceId, homeId, FROM + DAY, 'fluctuando');
    await addReport(deviceId, homeId, FROM + 2 * DAY, 'sin_luz');
    await addReport(deviceId, homeId, TO, 'sin_luz'); // `to` no entra

    const body = await getOk(token);

    expect(body.reports).toEqual([
      { at: FROM + 2 * DAY, value: 'sin_luz' },
      { at: FROM + DAY, value: 'fluctuando' },
      { at: FROM, value: 'hay_luz' },
    ]);
  });

  it('sin cortes ni reportes responde listas vacías y los días en 0', async () => {
    const { token } = await register(true);

    const body = await getOk(token);

    expect(body.items).toEqual([]);
    expect(body.reports).toEqual([]);
    expect(body.totalMs).toBe(0);
    expect(body.days).toHaveLength(7);
  });

  it('rango invertido o de más de 92 días responde 400 validation_failed sin consultar la base', async () => {
    const { token } = await register(true);
    const bad = [
      range(TO, FROM), // invertido
      range(FROM, FROM), // vacío
      range(FROM, FROM + MAX_SPAN + 1), // 92 días y 1 ms
      range(FROM, FROM + 200 * DAY),
      `/v1/homes/me/outages?to=${TO}`, // falta from
      `/v1/homes/me/outages?from=${FROM}`, // falta to
      '/v1/homes/me/outages',
      `/v1/homes/me/outages?from=ayer&to=${TO}`,
      `/v1/homes/me/outages?from=${FROM}&to=`,
      `/v1/homes/me/outages?from=-5&to=${TO}`,
      `/v1/homes/me/outages?from=1.5&to=${TO}`,
    ];
    for (const path of bad) {
      const res = await call(path, token);
      expect(res.status, path).toBe(400);
      const body = (await res.json()) as { error: { code: string; issues?: unknown[] } };
      expect(body.error.code).toBe('validation_failed');
      expect(body.error.issues?.length).toBeGreaterThan(0);
    }
    expect(queries).toBe(0);
  });

  it('un epoch ms más allá del año 2100 responde 400 sin consultar la base (no es un 500)', async () => {
    const { token } = await register(true);
    for (const path of [
      range(8_700_000_000_000_000, 8_700_000_000_001_000), // `new Date` lanzaría Invalid time value
      range(4_102_444_800_001 - DAY, 4_102_444_800_001), // un ms después del tope, con el rango de 1 día: solo falla el tope
    ]) {
      const res = await call(path, token);
      expect(res.status, path).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('validation_failed');
    }
    expect(queries).toBe(0);
  });

  it('acepta un `to` justo en el tope del año 2100', async () => {
    const { token } = await register(true);
    const to = 4_102_444_800_000;

    const res = await call(range(to - 7 * DAY, to), token);

    expect(res.status).toBe(200);
  });

  it('los reportes se limitan a los 1000 más recientes, y siguen del más reciente al más viejo', async () => {
    const { token, deviceId, homeId } = await register(true);
    await sql`
      INSERT INTO app.events (device_id, id, home_id, kind, device_at, at, payload, received_at)
      SELECT ${deviceId}, gen_random_uuid(), ${homeId}, 'report', ${FROM}::bigint + g, ${FROM}::bigint + g,
             jsonb_build_object('kind', 'report', 'value', 'hay_luz'), ${FROM}::bigint + g
      FROM generate_series(1, 1005) AS g`;

    const body = await getOk(token);

    expect(body.reports).toHaveLength(1000);
    expect(body.reports[0]?.at).toBe(FROM + 1005);
    expect(body.reports[999]?.at).toBe(FROM + 6);
  });

  it('acepta un rango de exactamente 92 días', async () => {
    const { token } = await register(true);

    const body = await getOk(token, range(FROM, FROM + MAX_SPAN));

    expect(body.days).toHaveLength(92);
  });

  it('sin token o con un token falso responde 401 sin consultar la base', async () => {
    expect((await call(range())).status).toBe(401);
    expect((await call(range(), 'a.b')).status).toBe(401);
    expect(queries).toBe(0);
  });

  it('sin casa responde 404', async () => {
    const { token } = await register(false);

    const res = await call(range(), token);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: 'not_found', message: expect.any(String) },
    });
    expect(queries).toBe(1); // solo la auth
  });

  it('gasta 2 consultas', async () => {
    const { token, deviceId, homeId } = await register(true);
    await addOutage(homeId, { start: FROM + HOUR, end: FROM + 2 * HOUR });
    await addReport(deviceId, homeId, FROM + HOUR, 'sin_luz');
    queries = 0;

    const res = await call(range(), token);

    expect(res.status).toBe(200);
    expect(queries).toBe(2); // auth + el CTE de cortes y reportes
  });

  it('no ve los cortes ni los reportes de otra casa', async () => {
    const mine = await register(true);
    const other = await register(true);
    await addOutage(other.homeId, { start: FROM + HOUR, end: FROM + 3 * HOUR });
    await addReport(other.deviceId, other.homeId, FROM + HOUR, 'sin_luz');
    const own = await addOutage(mine.homeId, { start: FROM + 5 * HOUR, end: FROM + 6 * HOUR });

    const body = await getOk(mine.token);

    expect(body.items.map((i) => i.id)).toEqual([own]);
    expect(body.reports).toEqual([]);
    expect(body.totalMs).toBe(HOUR);
  });
});
