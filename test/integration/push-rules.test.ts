import type postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { DeviceEvent, Diagnostics } from '../../src/domain/events/schema';
import type { Bindings, RateLimiter } from '../../src/env';
import { createApp } from '../../src/index';
import { runSweep } from '../../src/jobs/sweep';
import { type Notice, sendAndRecord } from '../../src/modules/push/notices';
import { claimStartPushes } from '../../src/modules/push/repo';
import { at, confirmation, MIN, snap } from '../../src/testing/builders';
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

/** Lo que llega a Expo, sin `deviceId` (no se manda). */
type SentMessage = {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  channelId: string;
  categoryId?: string;
  priority?: string;
};

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

describe('reglas de push', () => {
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

  /** El teléfono de la casa (con `push_token`, salvo que se pida sin) y su casa. */
  async function home({
    pushToken = 'ExponentPushToken[casa]',
    mode = 'base',
  }: {
    pushToken?: string | null;
    mode?: 'base' | 'ups';
  } = {}) {
    const device = await register(pushToken ?? undefined);
    const res = await call('POST', '/v1/homes', device.token, { alias: 'Mi casa' });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { homeId: string; shareCode: string };
    if (mode === 'ups') {
      expect((await call('PATCH', '/v1/homes/me', device.token, { mode })).status).toBe(204);
    }
    return { ...device, ...created };
  }

  async function follower(shareCode: string, alias: string, pushToken?: string) {
    const device = await register(pushToken);
    const res = await call('POST', '/v1/follows', device.token, { code: shareCode, alias });
    expect(res.status).toBe(201);
    return device;
  }

  /** Manda un lote con `sentAt` igual a la hora de la prueba (desfase 0) a la hora `minute`. */
  async function post(token: string, minute: number, events: DeviceEvent[]) {
    now = at(minute);
    queries = 0;
    const res = await call('POST', '/v1/events', token, {
      sentAt: now,
      diagnostics: DIAGNOSTICS,
      events,
    });
    expect(res.status).toBe(200);
    return res;
  }

  function sweep(minute: number) {
    return runSweep(testEnv(), at(minute), { fetch: expo.impl });
  }

  const bodies = () => expo.sent.map((m) => `${m.to} ${m.body}`);
  const ofType = (type: string) => expo.sent.filter((m) => m.data.type === type);

  async function outageMarks(homeId: string) {
    return sql<
      {
        start: number;
        status: string;
        createdAt: number | null;
        startNotified: number | null;
        endNotified: number | null;
        confirmAsked: number | null;
      }[]
    >`
      SELECT started_at::float8 AS start, status, created_at::float8 AS "createdAt",
             start_notified_at::float8 AS "startNotified",
             end_notified_at::float8 AS "endNotified",
             confirm_asked_at::float8 AS "confirmAsked"
      FROM app.outages WHERE home_id = ${homeId} ORDER BY started_at, id`;
  }

  /** Corte alta: armado a `from`, sin corriente ni Wi-Fi a `from + 5`. */
  const opening = (from: number) => [snap(from, true, true), snap(from + 5, false, false)];

  /** Una casa con un seguidor y un corte desde las 6:10 (conocido a las 6:11) cuyo inicio salió a las 6:21. */
  async function pushed() {
    const casa = await home();
    await follower(casa.shareCode, 'Casa de mamá', 'ExponentPushToken[hija]');
    await post(casa.token, 11, [snap(0, true, true), snap(10, false, false)]);
    await sweep(21);
    expect(bodies()).toEqual([
      'ExponentPushToken[hija] Se fue la luz en Casa de mamá (6:10 p. m.)',
    ]);
    return casa;
  }

  it('un corte de 10 min o más, conocido hace 30 min o menos, manda un inicio a cada seguidor', async () => {
    const casa = await home();
    await follower(casa.shareCode, 'Casa de mamá', 'ExponentPushToken[hija]');
    await follower(casa.shareCode, 'Donde la abuela', 'ExponentPushToken[nieto]');
    await post(casa.token, 6, opening(0)); // corte desde las 6:05 p. m., conocido a las 6:06

    expect((await sweep(10)).starts).toBe(0); // lleva 5 min: todavía no
    const result = await sweep(16);

    expect(result.starts).toBe(1);
    expect(expo.sent).toEqual([
      {
        to: 'ExponentPushToken[hija]',
        title: 'Pulso',
        body: 'Se fue la luz en Casa de mamá (6:05 p. m.)',
        data: { type: 'start', homeId: casa.homeId, outageStart: at(5) },
        channelId: 'cortes',
        priority: 'high',
      },
      {
        to: 'ExponentPushToken[nieto]',
        title: 'Pulso',
        body: 'Se fue la luz en Donde la abuela (6:05 p. m.)',
        data: { type: 'start', homeId: casa.homeId, outageStart: at(5) },
        channelId: 'cortes',
        priority: 'high',
      },
    ]);
    expect(await outageMarks(casa.homeId)).toMatchObject([
      { start: at(5), status: 'abierto', createdAt: at(6), startNotified: at(16) },
    ]);
    const [tickets] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM app.push_tickets`;
    expect(tickets?.n).toBe(2);

    // el sweep siguiente no repite nada
    expect((await sweep(21)).starts).toBe(0);
    expect(expo.sent).toHaveLength(2);
  });

  it('un corte que se conoció tarde no manda inicio y al cerrarse manda resumen tardío', async () => {
    const casa = await home();
    await follower(casa.shareCode, 'Casa de mamá', 'ExponentPushToken[hija]');
    await post(casa.token, 6, opening(0));

    // el cron no corrió en 30 min: el corte ya no es noticia
    expect((await sweep(37)).starts).toBe(0);
    await post(casa.token, 136, [snap(135, true, true)]);

    expect(ofType('start')).toEqual([]);
    expect(ofType('late').map((m) => m.body)).toEqual([
      'En Casa de mamá se fue la luz de 6:05 a 8:15 p. m. (2 h 10 min)',
    ]);
    expect(ofType('late')[0]?.priority).toBe('high');
    expect(ofType('late')[0]?.data).toEqual({
      type: 'late',
      homeId: casa.homeId,
      outageStart: at(5),
    });
  });

  it('un corte que llega entero, con el teléfono sin datos, manda solo el resumen tardío', async () => {
    const casa = await home();
    await follower(casa.shareCode, 'Casa de mamá', 'ExponentPushToken[hija]');

    await post(casa.token, 136, [...opening(0), snap(135, true, true)]);
    await sweep(140);

    expect(bodies()).toEqual([
      'ExponentPushToken[hija] En Casa de mamá se fue la luz de 6:05 a 8:15 p. m. (2 h 10 min)',
      'ExponentPushToken[casa] ¿Se fue la luz de 6:05 a 8:15 p. m.?',
    ]);
  });

  it('al cerrarse con inicio previo manda regreso con la duración', async () => {
    const casa = await home();
    await follower(casa.shareCode, 'Casa de mamá', 'ExponentPushToken[hija]');
    await post(casa.token, 6, opening(0));
    await sweep(16);

    await post(casa.token, 136, [snap(135, true, true)]);

    expect(bodies()).toEqual([
      'ExponentPushToken[hija] Se fue la luz en Casa de mamá (6:05 p. m.)',
      'ExponentPushToken[hija] Volvió la luz en Casa de mamá tras 2 h 10 min',
      'ExponentPushToken[casa] ¿Se fue la luz de 6:05 a 8:15 p. m.?',
    ]);
    expect(ofType('return')[0]?.priority).toBe('high');
    expect(ofType('return')[0]?.data).toEqual({
      type: 'return',
      homeId: casa.homeId,
      outageStart: at(5),
    });
    expect(ofType('confirm')).toEqual([
      {
        to: 'ExponentPushToken[casa]',
        title: 'Pulso',
        body: '¿Se fue la luz de 6:05 a 8:15 p. m.?',
        data: { type: 'confirm', outageStart: at(5) },
        channelId: 'cortes',
        categoryId: 'confirm_outage',
        priority: 'high',
      },
    ]);
    expect(await outageMarks(casa.homeId)).toMatchObject([
      { status: 'cerrado', startNotified: at(16), endNotified: at(136), confirmAsked: at(136) },
    ]);

    // reenviar el lote, o que el sweep vuelva a pasar, no repite nada
    await post(casa.token, 137, [snap(135, true, true), snap(136, true, true)]);
    await sweep(140);
    expect(expo.sent).toHaveLength(3);
  });

  it('un corte con inicio que termina descartado manda volvió la luz sin duración', async () => {
    const casa = await home();
    await follower(casa.shareCode, 'Casa de mamá', 'ExponentPushToken[hija]');
    await post(casa.token, 6, opening(0));
    await sweep(16);

    // el dueño responde "No, no se fue la luz"
    await post(casa.token, 21, [confirmation(20, 5, false)]);

    expect(bodies()).toEqual([
      'ExponentPushToken[hija] Se fue la luz en Casa de mamá (6:05 p. m.)',
      'ExponentPushToken[hija] Volvió la luz en Casa de mamá',
    ]);
    expect(ofType('return')[0]?.data).toEqual({
      type: 'return',
      homeId: casa.homeId,
      outageStart: at(5),
    });
    expect(await outageMarks(casa.homeId)).toMatchObject([
      { status: 'descartado', endNotified: at(21), confirmAsked: null },
    ]);
  });

  it('un corte descartado sin push de inicio no manda nada', async () => {
    const casa = await home();
    await follower(casa.shareCode, 'Casa de mamá', 'ExponentPushToken[hija]');
    await post(casa.token, 6, opening(0));

    await post(casa.token, 8, [confirmation(7, 5, false)]);
    await sweep(16);

    expect(expo.sent).toEqual([]);
  });

  it('dos sweeps y un cierre concurrente mandan exactamente un inicio y un regreso', async () => {
    const casa = await home();
    await follower(casa.shareCode, 'Casa de mamá', 'ExponentPushToken[hija]');
    await post(casa.token, 6, opening(0));
    const [outage] = await sql<{ id: string }[]>`
      SELECT id FROM app.outages WHERE home_id = ${casa.homeId}`;

    // una transacción toma el candado del corte: los dos sweeps y el cierre se encolan detrás
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = sql.begin(async (tx) => {
      await tx`SELECT 1 FROM app.outages WHERE id = ${outage?.id ?? ''} FOR UPDATE`;
      locked();
      await released;
    });
    await isLocked;

    const first = sweep(16);
    await waitForLockWaits(1);
    const second = sweep(16);
    await waitForLockWaits(2);
    now = at(136);
    const closing = call('POST', '/v1/events', casa.token, {
      sentAt: now,
      diagnostics: DIAGNOSTICS,
      events: [snap(135, true, true)],
    });
    await waitForLockWaits(3);
    release();
    await holder;
    const results = await Promise.all([first, second]);
    expect((await closing).status).toBe(200);

    expect(results.map((r) => r.starts).sort()).toEqual([0, 1]);
    expect(ofType('start')).toHaveLength(1);
    expect(ofType('return')).toHaveLength(1);
    expect(ofType('late')).toHaveLength(0);
    expect(await outageMarks(casa.homeId)).toMatchObject([
      { status: 'cerrado', startNotified: at(16), endNotified: at(136) },
    ]);
  });

  it('un corte que cambia de id al reconciliar no repite el push de inicio', async () => {
    const casa = await home();
    await follower(casa.shareCode, 'Casa de mamá', 'ExponentPushToken[hija]');
    await post(casa.token, 11, [snap(0, true, true), snap(10, false, false)]);
    await sweep(21);
    expect(bodies()).toEqual([
      'ExponentPushToken[hija] Se fue la luz en Casa de mamá (6:10 p. m.)',
    ]);
    const [before] = await outageMarks(casa.homeId);

    // llegan tarde dos snapshots: el corte empezó a la 6:01, 9 min antes (fuera de la tolerancia)
    await post(casa.token, 22, [snap(1, false, true), snap(3, false, false)]);

    const marks = await outageMarks(casa.homeId);
    expect(marks).toMatchObject([
      { start: at(1), status: 'abierto', createdAt: at(11), startNotified: at(21) },
      { start: at(10), status: 'descartado', startNotified: at(21), endNotified: null },
    ]);
    expect(before?.createdAt).toBe(at(11));
    await sweep(31);
    expect(expo.sent).toHaveLength(1); // ni otro inicio ni "volvió la luz"

    await post(casa.token, 131, [snap(130, true, true)]);
    expect(ofType('start')).toHaveLength(1);
    expect(ofType('return').map((m) => m.body)).toEqual([
      'Volvió la luz en Casa de mamá tras 2 h 9 min',
    ]);
  });

  it('un sweep que reclama el inicio mientras el corte cambia de id no lo repite', async () => {
    const casa = await home();
    await follower(casa.shareCode, 'Casa de mamá', 'ExponentPushToken[hija]');
    await post(casa.token, 11, [snap(0, true, true), snap(10, false, false)]);

    // un sweep marca el inicio del corte y todavía no confirma
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let claimedOpen!: () => void;
    const isClaimed = new Promise<void>((resolve) => {
      claimedOpen = resolve;
    });
    const claiming = sql.begin(async (tx) => {
      const claimed = await claimStartPushes(tx as unknown as postgres.Sql, at(21));
      claimedOpen();
      await released;
      return claimed;
    });
    await isClaimed;
    // mientras tanto llega el lote que cambia el id del corte: espera el candado del corte
    const changing = post(casa.token, 22, [snap(1, false, true), snap(3, false, false)]);
    await waitForLockWaits(1);
    release();
    const claimed = (await claiming) as Notice[];
    await changing;
    await sendAndRecord(sql, claimed, at(21), { fetch: expo.impl });

    await sweep(31);
    await sweep(36);

    expect(ofType('start')).toHaveLength(1);
    expect(await outageMarks(casa.homeId)).toMatchObject([
      { start: at(1), status: 'abierto', startNotified: at(21) },
      { start: at(10), status: 'descartado', startNotified: at(21) },
    ]);
  });

  it('un corte con inicio que al cambiar de id queda descartado manda volvió la luz una vez', async () => {
    const casa = await home();
    await follower(casa.shareCode, 'Casa de mamá', 'ExponentPushToken[hija]');
    await post(casa.token, 11, [snap(0, true, true), snap(10, false, false)]);
    await sweep(21);

    // llegan tarde: empezó a la 6:01 y a las 6:25 el teléfono volvió a una red que no sabe si es la
    // de casa, así que el corte nuevo (otro id) queda descartado
    await post(casa.token, 26, [
      snap(1, false, true),
      snap(3, false, false),
      snap(25, false, true),
    ]);
    await sweep(31);

    expect(bodies()).toEqual([
      'ExponentPushToken[hija] Se fue la luz en Casa de mamá (6:10 p. m.)',
      'ExponentPushToken[hija] Volvió la luz en Casa de mamá',
    ]);
  });

  it('un corte posterior del mismo lote no hereda el inicio de otro corte', async () => {
    const casa = await home();
    await follower(casa.shareCode, 'Casa de mamá', 'ExponentPushToken[hija]');
    await post(casa.token, 11, [snap(0, true, true), snap(10, false, false)]);
    await sweep(21);

    // llega tarde: el corte de las 6:10 en realidad empezó a las 6:01 y se descartó a las 6:25
    // (otro id, descartado), y a las 6:35 empezó otro corte de verdad
    await post(casa.token, 40, [
      snap(1, false, true),
      snap(3, false, false),
      snap(25, false, true),
      snap(30, true, true),
      snap(35, false, false),
    ]);
    expect(bodies()).toEqual([
      'ExponentPushToken[hija] Se fue la luz en Casa de mamá (6:10 p. m.)',
      'ExponentPushToken[hija] Volvió la luz en Casa de mamá',
    ]);
    expect(await outageMarks(casa.homeId)).toMatchObject([
      { start: at(1), status: 'descartado', startNotified: null },
      { start: at(10), status: 'descartado', startNotified: at(21), endNotified: at(40) },
      { start: at(35), status: 'abierto', createdAt: at(40), startNotified: null },
    ]);

    // el corte de las 6:35 tiene su propio inicio y su propio regreso
    await sweep(46);
    await sweep(51);
    await post(casa.token, 131, [snap(130, true, true)]);
    expect(ofType('start').map((m) => m.body)).toEqual([
      'Se fue la luz en Casa de mamá (6:10 p. m.)',
      'Se fue la luz en Casa de mamá (6:35 p. m.)',
    ]);
    expect(ofType('return').map((m) => m.body)).toEqual([
      'Volvió la luz en Casa de mamá',
      'Volvió la luz en Casa de mamá tras 1 h 35 min',
    ]);
  });

  it('un corte emparejado a un descartado cercano no le pasa su inicio a un corte posterior', async () => {
    const casa = await home();
    await follower(casa.shareCode, 'Casa de mamá', 'ExponentPushToken[hija]');
    await post(casa.token, 11, [snap(0, true, true), snap(10, false, false)]);
    await sweep(21);

    // llega tarde: el corte de las 6:10 (mismo id, empieza a las 6:06) se descartó a las 6:25, y a
    // las 6:35 empezó otro corte de verdad
    await post(casa.token, 40, [
      snap(6, false, true),
      snap(7, false, false),
      snap(25, false, true),
      snap(30, true, true),
      snap(35, false, false),
    ]);
    expect(bodies()).toEqual([
      'ExponentPushToken[hija] Se fue la luz en Casa de mamá (6:10 p. m.)',
      'ExponentPushToken[hija] Volvió la luz en Casa de mamá',
    ]);
    expect(await outageMarks(casa.homeId)).toMatchObject([
      { start: at(6), status: 'descartado', startNotified: at(21), endNotified: at(40) },
      { start: at(35), status: 'abierto', createdAt: at(40), startNotified: null },
    ]);

    await sweep(46);
    await sweep(51);
    await post(casa.token, 131, [snap(130, true, true)]);
    expect(ofType('start').map((m) => m.body)).toEqual([
      'Se fue la luz en Casa de mamá (6:10 p. m.)',
      'Se fue la luz en Casa de mamá (6:35 p. m.)',
    ]);
    expect(ofType('return').map((m) => m.body)).toEqual([
      'Volvió la luz en Casa de mamá',
      'Volvió la luz en Casa de mamá tras 1 h 35 min',
    ]);
  });

  it('un corte que cambia de id y ya terminó cuando salió su inicio manda un solo regreso', async () => {
    const casa = await home();
    await follower(casa.shareCode, 'Casa de mamá', 'ExponentPushToken[hija]');
    await post(casa.token, 11, [snap(0, true, true), snap(10, false, false)]);
    await sweep(21);

    // llega tarde: el corte de las 6:10 empezó a las 6:01 (otro id) y terminó a las 6:18, antes
    // del aviso de las 6:21. El aviso anunció ese corte: hereda el inicio y manda su regreso
    await post(casa.token, 30, [snap(1, false, true), snap(3, false, false), snap(18, true, true)]);
    await sweep(31);

    expect(bodies()).toEqual([
      'ExponentPushToken[hija] Se fue la luz en Casa de mamá (6:10 p. m.)',
      'ExponentPushToken[hija] Volvió la luz en Casa de mamá tras 17 min',
      'ExponentPushToken[casa] ¿Se fue la luz de 6:01 a 6:18 p. m.?',
    ]);
    expect(ofType('late')).toEqual([]);
    expect(await outageMarks(casa.homeId)).toMatchObject([
      {
        start: at(1),
        status: 'cerrado',
        createdAt: at(11),
        startNotified: at(21),
        endNotified: at(30),
        confirmAsked: at(30),
      },
      { start: at(10), status: 'descartado', startNotified: at(21), endNotified: null },
    ]);
  });

  it.each([
    ['1 min', 17],
    ['3 min', 19],
  ])(
    'un parpadeo de %s después de un corte que cambió de id no le quita el inicio',
    async (_, back) => {
      const casa = await pushed();

      // llega tarde: el corte de las 6:10 empezó a las 6:01 (otro id) y terminó a las 6:13, antes
      // del aviso; a las 6:16 hubo un parpadeo (descartado), más cerca de las 6:10 que las 6:01
      await post(casa.token, 30, [
        snap(1, false, true),
        snap(3, false, false),
        snap(13, true, true),
        snap(16, false, false),
        snap(back, true, true),
      ]);
      await sweep(31);

      expect(bodies()).toEqual([
        'ExponentPushToken[hija] Se fue la luz en Casa de mamá (6:10 p. m.)',
        'ExponentPushToken[hija] Volvió la luz en Casa de mamá tras 12 min',
        'ExponentPushToken[casa] ¿Se fue la luz de 6:01 a 6:13 p. m.?',
      ]);
      expect(await outageMarks(casa.homeId)).toMatchObject([
        { start: at(1), status: 'cerrado', createdAt: at(11), startNotified: at(21) },
        { start: at(10), status: 'descartado', startNotified: at(21), endNotified: null },
        { start: at(16), status: 'descartado', startNotified: null, endNotified: null },
      ]);
    },
  );

  it('un "No" que llega con un cambio de id no manda ningún aviso más', async () => {
    const casa = await pushed();
    await post(casa.token, 41, [snap(40, true, true)]);
    expect(expo.sent).toHaveLength(3); // regreso y confirmación del corte de 6:10 a 6:40

    // llega tarde: el corte empezó a las 6:01 (otro id), junto con un "No" para el de las 6:10
    await post(casa.token, 50, [
      snap(1, false, true),
      snap(3, false, false),
      confirmation(49, 10, false),
    ]);
    await sweep(51);

    expect(bodies()).toEqual([
      'ExponentPushToken[hija] Se fue la luz en Casa de mamá (6:10 p. m.)',
      'ExponentPushToken[hija] Volvió la luz en Casa de mamá tras 30 min',
      'ExponentPushToken[casa] ¿Se fue la luz de 6:10 a 6:40 p. m.?',
    ]);
    expect(await outageMarks(casa.homeId)).toMatchObject([
      {
        start: at(1),
        status: 'cerrado',
        createdAt: at(11),
        startNotified: at(21),
        endNotified: at(41),
        confirmAsked: at(41),
      },
      {
        start: at(10),
        status: 'descartado',
        startNotified: at(21),
        endNotified: at(41),
        confirmAsked: null,
      },
    ]);
  });

  it('apply_outages elige como heredero el corte anunciado, nunca uno posterior ni un parpadeo', async () => {
    const casa = await pushed();
    const [g] = await sql<{ id: string }[]>`
      SELECT id FROM app.outages WHERE home_id = ${casa.homeId}`;
    const outage = (start: number, end: number | null, status: string, confidence = 'alta') => ({
      start: at(start),
      end: end === null ? null : at(end),
      status,
      confidence,
      confirmed: null,
    });
    const insert = (n: number, o: ReturnType<typeof outage>) => ({
      op: 'insert',
      id: `01a1888b-0000-7000-8000-00000000000${n}`,
      outage: o,
    });

    /** Aplica a las 6:40 el huérfano G (intervalo de antes, descartado) más `extra`, y deshace. */
    async function apply(extra: unknown[]) {
      let result: { kinds: string[]; rows: unknown[] } | undefined;
      await sql
        .begin(async (tx) => {
          const [home] = await tx<{ rev: string }[]>`
            SELECT ingest_revision::text AS rev FROM app.homes WHERE id = ${casa.homeId}`;
          const changes = [
            { op: 'update', id: g?.id, outage: outage(10, null, 'descartado') },
            ...extra,
          ];
          const [row] = await tx<{ r: { notify: { kind: string }[] } }[]>`
            SELECT app.apply_outages(${casa.homeId}::uuid, ${home?.rev ?? ''}::bigint,
                                     ${JSON.stringify(changes)}::text::jsonb, null, ${at(40)}) AS r`;
          const rows = await tx`
            SELECT ((started_at - ${at(0)}) / ${MIN})::int AS s, status,
                   ((start_notified_at - ${at(0)}) / ${MIN})::int AS sn,
                   ((end_notified_at - ${at(0)}) / ${MIN})::int AS en,
                   ((created_at - ${at(0)}) / ${MIN})::int AS c
            FROM app.outages WHERE home_id = ${casa.homeId} ORDER BY started_at`;
          result = { kinds: (row?.r.notify ?? []).map((n) => n.kind), rows: [...rows] };
          throw new Error('deshacer');
        })
        .catch((error: Error) => {
          if (error.message !== 'deshacer') throw error;
        });
      return result;
    }

    // uno que empezó después del aviso no es el anunciado: G manda su "volvió la luz"
    expect(await apply([insert(1, outage(35, null, 'abierto'))])).toEqual({
      kinds: ['return_plain'],
      rows: [
        { s: 10, status: 'descartado', sn: 21, en: 40, c: 11 },
        { s: 35, status: 'abierto', sn: null, en: null, c: 40 },
      ],
    });
    // el anunciado terminó antes del aviso: hereda el inicio y manda su regreso
    expect(await apply([insert(2, outage(1, 18, 'cerrado'))])).toEqual({
      kinds: ['return', 'confirm'],
      rows: [
        { s: 1, status: 'cerrado', sn: 21, en: 40, c: 11 },
        { s: 10, status: 'descartado', sn: 21, en: null, c: 11 },
      ],
    });
    // un parpadeo descartado más cercano a G no le gana al corte que contiene su inicio
    expect(
      await apply([
        insert(3, outage(1, 13, 'cerrado')),
        insert(4, outage(16, 17, 'descartado', 'media')),
      ]),
    ).toEqual({
      kinds: ['return', 'confirm'],
      rows: [
        { s: 1, status: 'cerrado', sn: 21, en: 40, c: 11 },
        { s: 10, status: 'descartado', sn: 21, en: null, c: 11 },
        { s: 16, status: 'descartado', sn: null, en: null, c: 40 },
      ],
    });
    // solo: G manda su "volvió la luz"
    expect(await apply([])).toEqual({
      kinds: ['return_plain'],
      rows: [{ s: 10, status: 'descartado', sn: 21, en: 40, c: 11 }],
    });
  });

  it('un corte que se acorta a menos de 10 min después de su inicio manda volvió la luz una vez', async () => {
    const casa = await home();
    await follower(casa.shareCode, 'Casa de mamá', 'ExponentPushToken[hija]');
    await post(casa.token, 11, [snap(0, true, true), snap(10, false, false)]);
    await sweep(21);

    // llega tarde: el mismo corte volvió a las 6:18; de 6:10 a 6:18 no llega a 10 min
    await post(casa.token, 30, [snap(18, true, true)]);
    await sweep(31);

    expect(bodies()).toEqual([
      'ExponentPushToken[hija] Se fue la luz en Casa de mamá (6:10 p. m.)',
      'ExponentPushToken[hija] Volvió la luz en Casa de mamá',
    ]);
    expect(await outageMarks(casa.homeId)).toMatchObject([
      { start: at(10), status: 'descartado', startNotified: at(21), endNotified: at(30) },
    ]);
  });

  it('un corte posterior no hereda el created_at de un corte sin inicio y manda su propio inicio', async () => {
    const casa = await home();
    await follower(casa.shareCode, 'Casa de mamá', 'ExponentPushToken[hija]');
    // el servidor conoce el corte de las 6:10 desde las 6:11; el sweep todavía no avisó
    await post(casa.token, 11, [snap(0, true, true), snap(10, false, false)]);

    // llega tarde: ese corte (mismo id) se descartó a las 6:25, y a las 6:35 empezó otro
    await post(casa.token, 40, [
      snap(6, false, true),
      snap(7, false, false),
      snap(25, false, true),
      snap(30, true, true),
      snap(35, false, false),
    ]);
    expect(await outageMarks(casa.homeId)).toMatchObject([
      { start: at(6), status: 'descartado', createdAt: at(11), startNotified: null },
      { start: at(35), status: 'abierto', createdAt: at(40), startNotified: null },
    ]);

    await sweep(46);
    expect(bodies()).toEqual([
      'ExponentPushToken[hija] Se fue la luz en Casa de mamá (6:35 p. m.)',
    ]);
  });

  it('un corte que va y vuelve entre dos ids manda un solo inicio y un solo regreso', async () => {
    const casa = await home();
    await follower(casa.shareCode, 'Casa de mamá', 'ExponentPushToken[hija]');
    await post(casa.token, 11, [snap(0, true, true), snap(10, false, false)]);
    await sweep(21);
    await post(casa.token, 22, [snap(1, false, true), snap(3, false, false)]);
    await post(casa.token, 23, [snap(8, true, true)]);

    await post(casa.token, 60, [snap(59, true, true)]);
    await sweep(61);

    expect(ofType('start')).toHaveLength(1);
    expect(ofType('return').map((m) => m.body)).toEqual([
      'Volvió la luz en Casa de mamá tras 49 min',
    ]);
  });

  it('un corte que revive al reconciliar manda su regreso y no un volvió la luz falso', async () => {
    const casa = await home();
    await follower(casa.shareCode, 'Casa de mamá', 'ExponentPushToken[hija]');
    await post(casa.token, 11, [snap(0, true, true), snap(10, false, false)]);
    await sweep(21);
    // el corte cambia de id: ahora empieza a la 6:01
    await post(casa.token, 22, [snap(1, false, true), snap(3, false, false)]);
    // y otro snapshot atrasado lo parte: de 6:01 a 6:08 fue un bajón, y el de las 6:10 revive
    await post(casa.token, 23, [snap(8, true, true)]);

    expect(await outageMarks(casa.homeId)).toMatchObject([
      { start: at(1), status: 'descartado' },
      { start: at(10), status: 'abierto', startNotified: at(21), endNotified: null },
    ]);
    await sweep(31);
    expect(expo.sent).toHaveLength(1); // ni otro inicio ni "volvió la luz"

    await post(casa.token, 131, [snap(130, true, true)]);
    expect(ofType('start')).toHaveLength(1);
    expect(ofType('return').map((m) => m.body)).toEqual(['Volvió la luz en Casa de mamá tras 2 h']);
  });

  it('el cupo de alta no cuenta dos veces una confirmación que pasó a otro id', async () => {
    const casa = await home();
    await post(casa.token, 31, [snap(0, true, true), snap(10, false, false), snap(30, true, true)]);
    // el corte cerrado cambia de id: la confirmación ya pedida pasa al nuevo
    await post(casa.token, 32, [snap(1, false, true), snap(3, false, false)]);
    await post(casa.token, 61, [snap(45, false, false), snap(60, true, true)]);
    await post(casa.token, 91, [snap(75, false, false), snap(90, true, true)]);

    expect(ofType('confirm').map((m) => m.data.outageStart)).toEqual([at(10), at(45)]);
    const [asked] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.outages
      WHERE home_id = ${casa.homeId} AND confirm_asked_at IS NOT NULL`;
    expect(asked?.n).toBe(2);
  });

  it('confianza media pide confirmación siempre; alta, como máximo 2 al día', async () => {
    const casa = await home({ mode: 'ups' });
    // tres cortes alta (corriente y Wi-Fi juntos) en lotes separados
    await post(casa.token, 21, [...opening(0), snap(20, true, true)]);
    await post(casa.token, 46, [snap(30, false, false), snap(45, true, true)]);
    await post(casa.token, 76, [snap(60, false, false), snap(75, true, true)]);
    // dos cortes media (UPS: deja de cargar en el Wi-Fi de casa con la pantalla apagada)
    await post(casa.token, 106, [
      snap(90, false, true, { interactive: false }),
      snap(105, true, true),
    ]);
    await post(casa.token, 136, [
      snap(120, false, true, { interactive: false }),
      snap(135, true, true),
    ]);
    // al día siguiente, un alta vuelve a preguntarse
    await post(casa.token, 1500, [snap(1470, false, false), snap(1490, true, true)]);

    const asked = await sql<{ start: number; confidence: string }[]>`
      SELECT started_at::float8 AS start, confidence FROM app.outages
      WHERE home_id = ${casa.homeId} AND confirm_asked_at IS NOT NULL ORDER BY started_at`;
    expect(asked).toEqual([
      { start: at(5), confidence: 'alta' },
      { start: at(30), confidence: 'alta' },
      { start: at(90), confidence: 'media' },
      { start: at(120), confidence: 'media' },
      { start: at(1470), confidence: 'alta' },
    ]);
    expect(ofType('confirm').map((m) => m.data.outageStart)).toEqual(asked.map((a) => a.start));
    expect(ofType('confirm').every((m) => m.to === 'ExponentPushToken[casa]')).toBe(true);
  });

  it('sin push_token en el teléfono de la casa no se pide confirmación ni se gasta el cupo', async () => {
    const casa = await home({ pushToken: null });

    await post(casa.token, 21, [...opening(0), snap(20, true, true)]);

    expect(expo.sent).toEqual([]);
    expect(await outageMarks(casa.homeId)).toMatchObject([
      { status: 'cerrado', endNotified: at(21), confirmAsked: null },
    ]);
  });

  it('un seguidor sin push_token no recibe nada y no rompe', async () => {
    const casa = await home({ pushToken: null });
    await follower(casa.shareCode, 'Sin token');
    await follower(casa.shareCode, 'Casa de mamá', 'ExponentPushToken[hija]');
    const sola = await home({ pushToken: null });
    await follower(sola.shareCode, 'Tampoco');
    await post(casa.token, 6, opening(0));
    await post(sola.token, 6, opening(0));

    const result = await sweep(16);
    await post(casa.token, 136, [snap(135, true, true)]);
    await post(sola.token, 136, [snap(135, true, true)]);

    expect(result.starts).toBe(1); // la casa sin destinatarios no cuenta
    expect(bodies()).toEqual([
      'ExponentPushToken[hija] Se fue la luz en Casa de mamá (6:05 p. m.)',
      'ExponentPushToken[hija] Volvió la luz en Casa de mamá tras 2 h 10 min',
    ]);
    // la casa sin nadie a quien avisar quedó marcada igual: nada sale después
    expect(await outageMarks(sola.homeId)).toMatchObject([
      { status: 'cerrado', startNotified: at(16), endNotified: at(136) },
    ]);
  });

  it('el dueño que sigue su propia casa recibe cada aviso una sola vez', async () => {
    const casa = await home();
    await follower(casa.shareCode, 'Casa de mamá', 'ExponentPushToken[hija]');
    const own = await call('POST', '/v1/follows', casa.token, {
      code: casa.shareCode,
      alias: 'Mi casa',
    });
    expect(own.status).toBe(201);
    // otro registro con el mismo token (p. ej. reinstaló la app) que también la sigue
    await follower(casa.shareCode, 'Repetida', 'ExponentPushToken[hija]');
    await post(casa.token, 6, opening(0));

    await sweep(16);
    await post(casa.token, 136, [snap(135, true, true)]);

    expect(bodies().sort()).toEqual(
      [
        'ExponentPushToken[casa] Se fue la luz en Mi casa (6:05 p. m.)',
        'ExponentPushToken[hija] Se fue la luz en Casa de mamá (6:05 p. m.)',
        'ExponentPushToken[casa] Volvió la luz en Mi casa tras 2 h 10 min',
        'ExponentPushToken[hija] Volvió la luz en Casa de mamá tras 2 h 10 min',
        'ExponentPushToken[casa] ¿Se fue la luz de 6:05 a 8:15 p. m.?',
      ].sort(),
    );
  });

  it('el lote sigue en 3 consultas cuando no hay avisos', async () => {
    const casa = await home();
    await follower(casa.shareCode, 'Casa de mamá', 'ExponentPushToken[hija]');

    await post(casa.token, 6, opening(0));
    expect(queries).toBe(3);
    expect(expo.sent).toEqual([]);

    await sweep(16);
    // con avisos (regreso y confirmación), la 4.ª consulta guarda los tickets
    await post(casa.token, 136, [snap(135, true, true)]);
    expect(queries).toBe(4);
    expect(expo.sent).toHaveLength(3);
    const [tickets] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM app.push_tickets`;
    expect(tickets?.n).toBe(3);
  });

  it('claimStartPushes es una consulta y solo reclama una vez', async () => {
    const casa = await home();
    await follower(casa.shareCode, 'Casa de mamá', 'ExponentPushToken[hija]');
    await post(casa.token, 6, opening(0));
    let counted = 0;
    const db = testDb({ onQuery: () => counted++ });

    const first = await claimStartPushes(db.sql, at(16));
    const second = await claimStartPushes(db.sql, at(16) + MIN);
    await db.sql.end();

    expect(counted).toBe(2);
    expect(first).toEqual([
      {
        kind: 'start',
        homeId: casa.homeId,
        outageStart: at(5),
        outageEnd: null,
        alias: 'Mi casa',
        targets: [
          {
            deviceId: expect.any(String),
            pushToken: 'ExponentPushToken[hija]',
            alias: 'Casa de mamá',
          },
        ],
      },
    ]);
    expect(second).toEqual([]);
  });

  it('apply_outages sigue siendo SECURITY INVOKER, con search_path fijo y sin EXECUTE para PUBLIC', async () => {
    const [fn] = await sql<
      { prosecdef: boolean; proconfig: string[] | null; public_execute: boolean }[]
    >`
      SELECT prosecdef, proconfig,
             EXISTS (
               SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
             ) AS public_execute
      FROM pg_proc
      WHERE oid = 'app.apply_outages(uuid, bigint, jsonb, jsonb, bigint)'::regprocedure`;
    expect(fn?.prosecdef).toBe(false);
    expect(fn?.proconfig).toContain('search_path=app, pg_temp');
    expect(fn?.public_execute).toBe(false);
  });

  /** Espera a que `n` consultas de otras conexiones estén esperando un candado. */
  async function waitForLockWaits(n: number) {
    for (let i = 0; i < 250; i++) {
      const [row] = await sql<{ n: string }[]>`
        SELECT count(*) AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND pid <> pg_backend_pid()`;
      if (Number(row?.n) >= n) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`no hubo ${n} consultas esperando un candado`);
  }
});
