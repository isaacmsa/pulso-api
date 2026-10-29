import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { DeviceEvent, Diagnostics } from '../../src/domain/events/schema';
import type { HomeStatus } from '../../src/domain/homes/schema';
import type { Bindings, RateLimiter } from '../../src/env';
import { createApp } from '../../src/index';
import { runSweep } from '../../src/jobs/sweep';
import { at, report, snap } from '../../src/testing/builders';
import { TEST_SIGNING_KEY, testDb, truncateAll } from './helpers';

const DIAGNOSTICS: Diagnostics = {
  appVersion: '1.0.0',
  manufacturer: 'Xiaomi',
  model: '25028RN03L',
  sdkInt: 35,
  standbyBucket: 10,
  ignoringBatteryOptimizations: true,
  pendingEvents: 0,
};

const DAY = 24 * 60; // minutos

function limiter(): RateLimiter {
  return { limit: async () => ({ success: true }) };
}

function testEnv(): Bindings {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('Falta TEST_DATABASE_URL');
  return {
    HYPERDRIVE: { connectionString: url },
    RATE_LIMIT_REGISTER: limiter(),
    RATE_LIMIT_EVENTS: limiter(),
    RATE_LIMIT_API: limiter(),
    RATE_LIMIT_PUBLIC: limiter(),
    ENVIRONMENT: 'test',
    TOKEN_SIGNING_KEY: TEST_SIGNING_KEY,
  };
}

type SentMessage = { to: string; body: string; data: Record<string, unknown> };

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

/** Un Expo de mentira: guarda cada mensaje y responde un ticket `ok` por mensaje. Jamás la red. */
function fakeExpo() {
  const sent: SentMessage[] = [];
  let tickets = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as unknown;
    if (String(url).endsWith('/push/send')) {
      const messages = body as SentMessage[];
      sent.push(...messages);
      return json({ data: messages.map(() => ({ status: 'ok', id: `ticket-${++tickets}` })) });
    }
    return json({ data: {} }); // recibos: todavía ninguno
  }) as typeof fetch;
  return { impl, sent };
}

type EventsResponse = { accepted: number; duplicated: number; status: HomeStatus };

describe('sin noticias y sin_datos', () => {
  const { sql } = testDb();
  let queries = 0;
  let now = at(0);
  let expo = fakeExpo();
  const app = createApp({
    onQuery: () => queries++,
    now: () => now,
    fetch: (input, init) => expo.impl(input, init),
  });

  beforeEach(async () => {
    await truncateAll(sql);
    queries = 0;
    now = at(0);
    expo = fakeExpo();
  });

  afterAll(async () => {
    await sql.end();
  });

  function call(method: string, path: string, token?: string, body?: unknown) {
    return app.request(
      path,
      {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      testEnv(),
    );
  }

  async function register(pushToken?: string) {
    const res = await call('POST', '/v1/devices', undefined, { appVersion: '1.0.0' });
    expect(res.status).toBe(201);
    const device = (await res.json()) as { deviceId: string; token: string };
    if (pushToken) {
      const patched = await call('PATCH', '/v1/devices/me', device.token, { pushToken });
      expect(patched.status).toBe(204);
    }
    return device;
  }

  /** El teléfono de la casa y su casa, creados a las 6:00 p. m. */
  async function home(pushToken?: string) {
    const device = await register(pushToken);
    const res = await call('POST', '/v1/homes', device.token, { alias: 'Mi casa' });
    expect(res.status).toBe(201);
    return { ...device, ...((await res.json()) as { homeId: string; shareCode: string }) };
  }

  async function follower(shareCode: string, alias: string, pushToken?: string) {
    const device = await register(pushToken);
    const res = await call('POST', '/v1/follows', device.token, { code: shareCode, alias });
    expect(res.status).toBe(201);
    return device;
  }

  /** Manda un lote (vacío = latido) a la hora `minute`, con desfase 0, y cuenta sus consultas. */
  async function post(token: string, minute: number, events: DeviceEvent[] = []) {
    now = at(minute);
    queries = 0;
    const res = await call('POST', '/v1/events', token, {
      sentAt: now,
      diagnostics: DIAGNOSTICS,
      events,
    });
    expect(res.status).toBe(200);
    return (await res.json()) as EventsResponse;
  }

  let sweepQueries = 0;
  function sweep(minute: number) {
    sweepQueries = 0;
    return runSweep(testEnv(), at(minute), {
      fetch: expo.impl,
      onQuery: () => sweepQueries++,
    });
  }

  async function homeRow(homeId: string) {
    const [row] = await sql<{ status: string; since: number; revision: number }[]>`
      SELECT status, status_since::float8 AS since, ingest_revision::float8 AS revision
      FROM app.homes WHERE id = ${homeId}`;
    return row;
  }

  async function outagesOf(homeId: string) {
    return sql<
      {
        start: number;
        end: number | null;
        status: string;
        startNotified: number | null;
        endNotified: number | null;
      }[]
    >`
      SELECT started_at::float8 AS start, ended_at::float8 AS "end", status,
             start_notified_at::float8 AS "startNotified", end_notified_at::float8 AS "endNotified"
      FROM app.outages WHERE home_id = ${homeId} ORDER BY started_at, id`;
  }

  /** Corte alta: armado a `from`, sin corriente ni Wi-Fi a `from + 5`. */
  const opening = (from: number) => [snap(from, true, true), snap(from + 5, false, false)];

  it('45 min sin latido deja la casa en sin_noticias desde el último latido', async () => {
    const casa = await home();
    await post(casa.token, 10);
    const before = await homeRow(casa.homeId);

    // 39 min sin latido: todavía no
    expect((await sweep(49)).stale).toEqual({ noNews: 0, noData: 0, reopened: 0 });
    expect(await homeRow(casa.homeId)).toMatchObject({ status: 'con_luz', since: at(0) });

    const result = await sweep(55);

    expect(result.stale).toEqual({ noNews: 1, noData: 0, reopened: 0 });
    // sube la revisión (A-023): un lote en vuelo no puede pisar el estado nuevo
    expect(await homeRow(casa.homeId)).toEqual({
      status: 'sin_noticias',
      since: at(10),
      revision: (before?.revision ?? 0) + 1,
    });
    // claimStartPushes, processReceipts y mark_stale
    expect(sweepQueries).toBe(3);

    // otra pasada no la vuelve a tocar
    expect((await sweep(60)).stale).toEqual({ noNews: 0, noData: 0, reopened: 0 });
    expect(await homeRow(casa.homeId)).toMatchObject({ since: at(10) });
  });

  it('el siguiente latido la regresa a con_luz con una consulta', async () => {
    const casa = await home();
    await post(casa.token, 10);
    await sweep(55);
    const stale = await homeRow(casa.homeId);

    const body = await post(casa.token, 60);

    expect(queries).toBe(1);
    expect(body.status).toEqual({
      state: 'con_luz',
      since: at(60),
      alias: 'Mi casa',
      openOutageStart: null,
    });
    expect(await homeRow(casa.homeId)).toEqual({
      status: 'con_luz',
      since: at(60),
      revision: (stale?.revision ?? 0) + 1,
    });

    // el latido siguiente ya no cambia nada
    await post(casa.token, 75);
    expect(await homeRow(casa.homeId)).toEqual({
      status: 'con_luz',
      since: at(60),
      revision: (stale?.revision ?? 0) + 1,
    });
  });

  it('cualquier petición del teléfono de la casa la regresa a con_luz', async () => {
    const casa = await home();
    await sweep(45);
    expect(await homeRow(casa.homeId)).toMatchObject({ status: 'sin_noticias', since: at(0) });

    now = at(50);
    const res = await call('GET', '/v1/homes/me/status', casa.token);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'con_luz', since: at(50) });
  });

  it('el latido de un seguidor no cambia el estado de otras casas', async () => {
    const casa = await home();
    const otra = await home();
    const hija = await follower(casa.shareCode, 'Casa de mamá');
    await sweep(45);
    expect(await homeRow(casa.homeId)).toMatchObject({ status: 'sin_noticias' });
    const before = await homeRow(casa.homeId);

    now = at(50);
    queries = 0;
    const res = await call('GET', '/v1/follows', hija.token);
    expect(res.status).toBe(200);
    // el teléfono de otra casa tampoco toca esta
    await post(otra.token, 50);

    expect(await homeRow(casa.homeId)).toEqual(before);
    expect(await homeRow(otra.homeId)).toMatchObject({ status: 'con_luz', since: at(50) });
  });

  it('con un corte abierto no pasa a sin_noticias', async () => {
    const casa = await home();
    await post(casa.token, 6, opening(0));
    expect(await homeRow(casa.homeId)).toMatchObject({ status: 'sin_luz', since: at(5) });

    expect((await sweep(60)).stale).toEqual({ noNews: 0, noData: 0, reopened: 0 });

    expect(await homeRow(casa.homeId)).toMatchObject({ status: 'sin_luz', since: at(5) });
  });

  /** El historial de la casa desde las 6:00 p. m. del día 0 hasta `minute`. */
  async function history(token: string, minute: number) {
    now = at(minute);
    const res = await call('GET', `/v1/homes/me/outages?from=${at(0)}&to=${at(minute)}`, token);
    expect(res.status).toBe(200);
    return (await res.json()) as { items: { status: string }[]; totalMs: number };
  }

  it('un corte de 30 h con latidos sigue abierto y suma horas', async () => {
    const casa = await home();
    await post(casa.token, 6, opening(0)); // corte desde las 6:05 p. m.
    // el teléfono sigue vivo por datos móviles: solo latidos, sin cambios que subir
    for (let minute = 15; minute <= 30 * 60; minute += 15) await post(casa.token, minute);

    expect((await sweep(30 * 60 + 2)).stale).toEqual({ noNews: 0, noData: 0, reopened: 0 });

    expect(await outagesOf(casa.homeId)).toMatchObject([{ status: 'abierto', end: null }]);
    expect(await homeRow(casa.homeId)).toMatchObject({ status: 'sin_luz', since: at(5) });
    const summary = await history(casa.token, 30 * 60 + 5);
    expect(summary.items.map((item) => item.status)).toEqual(['abierto']);
    expect(summary.totalMs).toBe(at(30 * 60 + 5) - at(5));
  });

  it('sin latidos por 24 h pasa a sin_datos y la casa a sin_noticias desde el último latido', async () => {
    const casa = await home();
    await post(casa.token, 6, opening(0));
    await post(casa.token, 20); // el último latido, a las 6:20 p. m.

    // 23 h 59 min sin latido: el corte sigue abierto y la casa sin luz
    expect((await sweep(DAY + 19)).stale).toEqual({ noNews: 0, noData: 0, reopened: 0 });
    expect(await outagesOf(casa.homeId)).toMatchObject([{ status: 'abierto' }]);
    expect(await homeRow(casa.homeId)).toMatchObject({ status: 'sin_luz', since: at(5) });
    const before = await homeRow(casa.homeId);

    const result = await sweep(DAY + 20);

    expect(result).toMatchObject({
      starts: 0,
      stale: { noNews: 1, noData: 1, reopened: 0 },
    });
    expect(await outagesOf(casa.homeId)).toEqual([
      { start: at(5), end: null, status: 'sin_datos', startNotified: null, endNotified: null },
    ]);
    expect(await homeRow(casa.homeId)).toEqual({
      status: 'sin_noticias',
      since: at(20),
      revision: (before?.revision ?? 0) + 1,
    });
    expect(sweepQueries).toBe(3);

    // no suma horas ni es el corte abierto de la casa (la consulta del historial es del
    // propio teléfono, que vuelve: el sweep siguiente lo reabriría)
    const [row] = await sql<{ open: number }[]>`
      SELECT count(*)::int AS open FROM app.outages
      WHERE home_id = ${casa.homeId} AND status = 'abierto'`;
    expect(row?.open).toBe(0);
    const summary = await history(casa.token, DAY + 25);
    expect(summary.items.map((item) => item.status)).toEqual(['sin_datos']);
    expect(summary.totalMs).toBe(0);
  });

  it('un corte sin_datos con eventos atrasados se cierra sin duplicarse', async () => {
    const casa = await home('ExponentPushToken[casa]');
    await follower(casa.shareCode, 'Casa de mamá', 'ExponentPushToken[hija]');
    await post(casa.token, 6, opening(0)); // el cron no corrió: el inicio nunca salió
    await sweep(DAY + 10);
    expect(await outagesOf(casa.homeId)).toMatchObject([{ status: 'sin_datos' }]);
    expect(await homeRow(casa.homeId)).toMatchObject({ status: 'sin_noticias', since: at(6) });

    // vuelve el teléfono con lo que tenía en cola: la luz volvió a las 8:15 p. m. del día 0
    const body = await post(casa.token, DAY + 30, [snap(135, true, true)]);

    // decide el lote, no la auth: con luz desde las 8:15 p. m., no desde la subida
    expect(body.status).toMatchObject({ state: 'con_luz', since: at(135), openOutageStart: null });
    expect(await homeRow(casa.homeId)).toMatchObject({ status: 'con_luz', since: at(135) });
    expect(await outagesOf(casa.homeId)).toEqual([
      {
        start: at(5),
        end: at(135),
        status: 'cerrado',
        startNotified: null,
        endNotified: at(DAY + 30),
      },
    ]);
    expect(expo.sent.map((m) => `${m.to} ${m.data.type} ${m.body}`)).toEqual([
      'ExponentPushToken[hija] late En Casa de mamá se fue la luz de 6:05 a 8:15 p. m. (2 h 10 min)',
      'ExponentPushToken[casa] confirm ¿Se fue la luz de 6:05 a 8:15 p. m.?',
    ]);

    // ni el sweep siguiente ni un reenvío repiten nada
    await sweep(DAY + 35);
    await post(casa.token, DAY + 36, [snap(135, true, true)]);
    expect(expo.sent).toHaveLength(2);
    expect(await outagesOf(casa.homeId)).toHaveLength(1);
  });

  it('un corte sin_datos que sigue sin luz vuelve a abierto sin repetir el inicio', async () => {
    const casa = await home();
    await follower(casa.shareCode, 'Casa de mamá', 'ExponentPushToken[hija]');
    await post(casa.token, 6, opening(0));
    await sweep(16); // sale el inicio
    await sweep(DAY + 10);
    expect(await outagesOf(casa.homeId)).toMatchObject([{ status: 'sin_datos' }]);

    // el teléfono vuelve en otra red: sigue sin luz en casa
    const body = await post(casa.token, DAY + 30, [
      snap(DAY + 29, false, true, { homeWifi: false }),
    ]);

    expect(body.status).toMatchObject({ state: 'sin_luz', since: at(5), openOutageStart: at(5) });
    expect(await outagesOf(casa.homeId)).toEqual([
      { start: at(5), end: null, status: 'abierto', startNotified: at(16), endNotified: null },
    ]);
    await sweep(DAY + 35);
    expect(expo.sent.map((m) => m.data.type)).toEqual(['start']);
  });

  it('un corte manual sin_datos se cierra con un hay_luz atrasado', async () => {
    const casa = await home();
    // corte manual a las 6:01 p. m., con un snapshot powered repetido dentro
    await post(casa.token, 6, [
      snap(0, true, true),
      report(1, 'sin_luz'),
      snap(2, true, true, { internet: false }),
    ]);
    await sweep(DAY + 10);
    expect(await outagesOf(casa.homeId)).toMatchObject([{ status: 'sin_datos' }]);

    await post(casa.token, DAY + 30, [report(60, 'hay_luz')]);

    expect(await outagesOf(casa.homeId)).toMatchObject([
      { start: at(1), end: at(60), status: 'cerrado' },
    ]);
    expect(await homeRow(casa.homeId)).toMatchObject({ status: 'con_luz', since: at(60) });
  });

  it('un latido vacío tras un sin_datos no dice que hay luz: el sweep reabre el corte', async () => {
    const casa = await home();
    await follower(casa.shareCode, 'Casa de mamá', 'ExponentPushToken[hija]');
    await post(casa.token, 6, opening(0));
    await sweep(16); // sale el inicio
    await sweep(DAY + 10);

    // vuelve con datos móviles y sin cambios que subir: la luz sigue sin volver
    const body = await post(casa.token, DAY + 30);

    expect(queries).toBe(1);
    expect(body.status).toMatchObject({ state: 'sin_noticias', since: at(6) });
    expect(await homeRow(casa.homeId)).toMatchObject({ status: 'sin_noticias' });
    const before = await homeRow(casa.homeId);

    expect((await sweep(DAY + 35)).stale).toEqual({ noNews: 0, noData: 0, reopened: 1 });

    expect(await outagesOf(casa.homeId)).toEqual([
      { start: at(5), end: null, status: 'abierto', startNotified: at(16), endNotified: null },
    ]);
    expect(await homeRow(casa.homeId)).toEqual({
      status: 'sin_luz',
      since: at(5),
      revision: (before?.revision ?? 0) + 1,
    });
    // la pasada siguiente no lo vuelve a tocar, y no sale otro inicio
    expect((await sweep(DAY + 40)).stale).toEqual({ noNews: 0, noData: 0, reopened: 0 });
    expect(expo.sent.map((m) => m.data.type)).toEqual(['start']);

    // vuelve la luz: sale el regreso con la duración completa
    await post(casa.token, DAY + 60, [snap(DAY + 59, true, true)]);
    expect(await homeRow(casa.homeId)).toMatchObject({ status: 'con_luz', since: at(DAY + 59) });
    expect(expo.sent.map((m) => m.data.type)).toEqual(['start', 'return']);
  });

  it('un lote con eventos tras sin_noticias deja con_luz desde el fin del corte, no desde la subida', async () => {
    const casa = await home();
    await post(casa.token, 10, [snap(10, true, true)]);
    await sweep(55);
    expect(await homeRow(casa.homeId)).toMatchObject({ status: 'sin_noticias', since: at(10) });

    // un corte de 7:00 a 8:00 p. m. que el teléfono tenía en cola
    const body = await post(casa.token, 200, [snap(60, false, false), snap(120, true, true)]);

    expect(body.status).toMatchObject({ state: 'con_luz', since: at(120) });
    expect(await homeRow(casa.homeId)).toMatchObject({ status: 'con_luz', since: at(120) });
  });

  it('un lote de solo duplicados deja la casa en sin_noticias hasta el siguiente latido', async () => {
    const casa = await home();
    const events = [snap(10, true, true)];
    await post(casa.token, 10, events);
    await sweep(55);

    const body = await post(casa.token, 60, events);

    expect(body).toMatchObject({ accepted: 0, status: { state: 'sin_noticias' } });
    await post(casa.token, 75);
    expect(await homeRow(casa.homeId)).toMatchObject({ status: 'con_luz', since: at(75) });
  });

  it('un sin_datos cuyo inicio ya se purgó no se reabre ni frena la vuelta a con_luz', async () => {
    const casa = await home();
    await post(casa.token, 10);
    // un corte de hace 31 días que la retención dejó en sin_datos
    await sql`
      INSERT INTO app.outages (id, home_id, started_at, ended_at, status, confidence, confirmed,
                               updated_at, created_at)
      VALUES (gen_random_uuid(), ${casa.homeId}, ${at(-31 * DAY)}, NULL, 'sin_datos', 'alta',
              NULL, ${at(0)}, ${at(-31 * DAY)})`;
    await sweep(55);
    expect(await homeRow(casa.homeId)).toMatchObject({ status: 'sin_noticias' });

    await post(casa.token, 60);
    expect(await homeRow(casa.homeId)).toMatchObject({ status: 'con_luz', since: at(60) });

    expect((await sweep(65)).stale).toEqual({ noNews: 0, noData: 0, reopened: 0 });
    expect(await outagesOf(casa.homeId)).toMatchObject([{ status: 'sin_datos' }]);
    expect(await homeRow(casa.homeId)).toMatchObject({ status: 'con_luz', since: at(60) });
  });

  it('un corte abierto cuyos eventos de inicio ya se purgaron no se reescribe', async () => {
    const casa = await home();
    await post(casa.token, 6, opening(0));
    // el teléfono pasa a otra red: el corte sigue abierto
    await post(casa.token, 100, [snap(100, false, true, { homeWifi: false })]);
    // la retención borró los eventos de su inicio (A-042)
    await sql`DELETE FROM app.events WHERE home_id = ${casa.homeId} AND at < ${at(100)}`;

    await post(casa.token, 200, [snap(200, true, true)]);

    expect(await outagesOf(casa.homeId)).toEqual([
      { start: at(5), end: null, status: 'abierto', startNotified: null, endNotified: null },
    ]);
  });
});
