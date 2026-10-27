import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classify } from '../../src/domain/detection/classify';
import {
  type DeviceEvent,
  type Diagnostics,
  deviceEventSchema,
} from '../../src/domain/events/schema';
import type { HomeStatus } from '../../src/domain/homes/schema';
import type { Bindings, RateLimiter } from '../../src/env';
import { createApp } from '../../src/index';
import { applyOutages, ingestBatch } from '../../src/modules/events/repo';
import { ingestEvents } from '../../src/modules/events/service';
import { at, confirmation, snap } from '../../src/testing/builders';
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

type EventsResponse = { accepted: number; duplicated: number; status: HomeStatus };

type OutageRow = {
  id: string;
  start: number;
  end: number | null;
  status: string;
  confidence: string;
  confirmed: boolean | null;
};

describe('POST /v1/events', () => {
  const { sql } = testDb();
  let queries = 0;
  let now = at(2000); // la hora del Worker en la prueba (receivedAt)
  const app = createApp({ onQuery: () => queries++, now: () => now });

  beforeEach(async () => {
    await truncateAll(sql);
    queries = 0;
    now = at(2000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  async function register() {
    const res = await call('POST', '/v1/devices', undefined, { appVersion: '1.0.0' });
    expect(res.status).toBe(201);
    return (await res.json()) as { deviceId: string; token: string };
  }

  async function registerWithHome() {
    const device = await register();
    const res = await call('POST', '/v1/homes', device.token, {});
    expect(res.status).toBe(201);
    const home = (await res.json()) as { homeId: string };
    queries = 0;
    return { ...device, ...home };
  }

  /** Manda un lote con `sentAt` igual a la hora de la prueba, salvo que se pida otro. */
  function post(token: string, events: unknown[], { sentAt = now }: { sentAt?: number } = {}) {
    return call('POST', '/v1/events', token, { sentAt, diagnostics: DIAGNOSTICS, events });
  }

  async function postOk(token: string, events: DeviceEvent[]): Promise<EventsResponse> {
    const res = await post(token, events);
    expect(res.status).toBe(200);
    return (await res.json()) as EventsResponse;
  }

  async function outagesOf(homeId: string) {
    return sql<OutageRow[]>`
      SELECT id, started_at::float8 AS start, ended_at::float8 AS "end", status, confidence,
             confirmed
      FROM app.outages WHERE home_id = ${homeId} ORDER BY started_at`;
  }

  async function homeRow(homeId: string) {
    const [row] = await sql<{ status: string; since: number }[]>`
      SELECT status, status_since::float8 AS since FROM app.homes WHERE id = ${homeId}`;
    return row;
  }

  async function pendingAnchorOf(homeId: string) {
    const [row] = await sql<{ pendingAnchor: number | null }[]>`
      SELECT pending_anchor::float8 AS "pendingAnchor" FROM app.homes WHERE id = ${homeId}`;
    return row?.pendingAnchor;
  }

  /** `ingest_batch` como lo llama el Worker, sin el `apply_outages` que le sigue (el Worker murió). */
  function ingestOnly(device: { deviceId: string; homeId: string }, events: DeviceEvent[]) {
    return ingestBatch(sql, {
      deviceId: device.deviceId,
      homeId: device.homeId,
      events,
      offsetMs: 0,
      receivedAt: now,
    });
  }

  it('un latido vacío gasta una consulta', async () => {
    const { token, deviceId } = await registerWithHome();

    const res = await post(token, []);

    expect(res.status).toBe(200);
    const body = (await res.json()) as EventsResponse;
    expect(body).toMatchObject({ accepted: 0, duplicated: 0, status: { state: 'con_luz' } });
    expect(queries).toBe(1);
    const [device] = await sql<{ lastSeenAt: number; diagnostics: Diagnostics }[]>`
      SELECT last_seen_at::float8 AS "lastSeenAt", diagnostics
      FROM app.devices WHERE id = ${deviceId}`;
    expect(device).toEqual({ lastSeenAt: now, diagnostics: DIAGNOSTICS });
  });

  it('un corte llega a sin_luz', async () => {
    const { token, homeId } = await registerWithHome();

    const body = await postOk(token, [snap(0, true, true), snap(5, false, false)]);

    expect(body).toEqual({
      accepted: 2,
      duplicated: 0,
      status: { state: 'sin_luz', since: at(5), alias: 'Casa', openOutageStart: at(5) },
    });
    expect(queries).toBe(3);
    const outages = await outagesOf(homeId);
    expect(outages).toHaveLength(1);
    expect(outages[0]).toMatchObject({
      start: at(5),
      end: null,
      status: 'abierto',
      confidence: 'alta',
      confirmed: null,
    });
    expect(await homeRow(homeId)).toEqual({ status: 'sin_luz', since: at(5) });
  });

  it('el corte se cierra con el lote siguiente', async () => {
    const { token, homeId } = await registerWithHome();
    await postOk(token, [snap(0, true, true), snap(5, false, false)]);
    const [opened] = await outagesOf(homeId);
    queries = 0;

    const body = await postOk(token, [snap(125, true, true)]);

    expect(body).toEqual({
      accepted: 1,
      duplicated: 0,
      status: { state: 'con_luz', since: at(125), alias: 'Casa', openOutageStart: null },
    });
    expect(queries).toBe(3);
    const outages = await outagesOf(homeId);
    expect(outages).toEqual([
      {
        id: opened?.id,
        start: at(5),
        end: at(125),
        status: 'cerrado',
        confidence: 'alta',
        confirmed: null,
      },
    ]);
    expect(await homeRow(homeId)).toEqual({ status: 'con_luz', since: at(125) });
  });

  it('reenviar el mismo lote no cambia nada', async () => {
    const { token, homeId } = await registerWithHome();
    const events = [snap(0, true, true), snap(5, false, false), snap(6, false, false)];
    const first = await postOk(token, events);
    expect(first.status.state).toBe('sin_luz');
    const outagesBefore = await outagesOf(homeId);
    const homeBefore = await homeRow(homeId);
    queries = 0;
    now += 60_000; // el reintento llega un minuto después, con otro sentAt

    const body = await postOk(token, events);

    expect(body).toEqual({ accepted: 0, duplicated: events.length, status: first.status });
    expect(queries).toBe(2);
    expect(await outagesOf(homeId)).toEqual(outagesBefore);
    expect(await homeRow(homeId)).toEqual(homeBefore);
    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.events WHERE home_id = ${homeId}`;
    expect(count?.n).toBe(events.length);
  });

  it('un reenvío normal sigue gastando dos consultas', async () => {
    const { token, homeId } = await registerWithHome();
    const events = [snap(0, true, true), snap(5, false, false)];
    const first = await postOk(token, events);
    expect(await pendingAnchorOf(homeId)).toBeNull();
    queries = 0;

    const body = await postOk(token, events);

    expect(body).toEqual({ accepted: 0, duplicated: events.length, status: first.status });
    expect(queries).toBe(2);
    expect(await pendingAnchorOf(homeId)).toBeNull();
  });

  it('un reintento después de un apply perdido clasifica', async () => {
    const { token, deviceId, homeId } = await registerWithHome();
    const events = [snap(0, true, true), snap(5, false, false)];
    // el Worker guardó el lote y murió antes de apply_outages: el teléfono no recibió respuesta
    const lost = await ingestOnly({ deviceId, homeId }, events);
    expect(lost.accepted).toBe(2);
    expect(await outagesOf(homeId)).toEqual([]);
    queries = 0;
    now += 60_000;

    const body = await postOk(token, events);

    expect(body).toEqual({
      accepted: 0,
      duplicated: events.length,
      status: { state: 'sin_luz', since: at(5), alias: 'Casa', openOutageStart: at(5) },
    });
    expect(queries).toBe(3);
    expect(await outagesOf(homeId)).toMatchObject([
      { start: at(5), end: null, status: 'abierto', confidence: 'alta' },
    ]);
    expect(await homeRow(homeId)).toEqual({ status: 'sin_luz', since: at(5) });
    expect(await pendingAnchorOf(homeId)).toBeNull();
  });

  it('un reintento que se cruza no pierde los cortes del lote original', async () => {
    now = at(-1);
    const { token, deviceId, homeId } = await registerWithHome();
    const a = [
      snap(0, true, true),
      snap(5, false, true),
      snap(6, false, false),
      snap(125, true, true),
    ];
    const b = [...a, snap(200, true, true, { internet: false })];
    now = at(130);
    // A guarda y clasifica, pero su apply_outages llega después de que B ingiera
    const ingestedA = await ingestOnly({ deviceId, homeId }, a);
    const detectedA = classify(ingestedA.window, { mode: ingestedA.mode });
    expect(detectedA).toMatchObject([{ start: at(5), end: at(125), status: 'cerrado' }]);
    now = at(201);

    const body = await postOk(token, b);
    const appliedA = await applyOutages(sql, {
      homeId,
      revision: ingestedA.revision,
      changes: detectedA.map((outage) => ({ op: 'insert' as const, id: randomUUID(), outage })),
      status: null,
      now,
    });

    expect(body).toMatchObject({ accepted: 1, duplicated: a.length });
    expect(appliedA.applied).toBe(false);
    expect(await outagesOf(homeId)).toMatchObject([
      { start: at(5), end: at(125), status: 'cerrado', confidence: 'alta' },
    ]);
    // el corte se abrió y se cerró dentro de la ventana: la casa sigue en con_luz desde que se creó
    expect(await homeRow(homeId)).toEqual({ status: 'con_luz', since: at(-1) });
    expect(await pendingAnchorOf(homeId)).toBeNull();
  });

  it('el desfase de reloj se corrige', async () => {
    const { token, deviceId } = await registerWithHome();
    const event = snap(0, true, true);

    const res = await post(token, [event], { sentAt: now - 120_000 });

    expect(res.status).toBe(200);
    const [row] = await sql<{ deviceAt: number; at: number; receivedAt: number }[]>`
      SELECT device_at::float8 AS "deviceAt", at::float8 AS at, received_at::float8 AS "receivedAt"
      FROM app.events WHERE device_id = ${deviceId} AND id = ${event.id}`;
    expect(row).toEqual({ deviceAt: event.at, at: event.at + 120_000, receivedAt: now });
  });

  it('una confirmación tardía descarta el corte', async () => {
    const { token, homeId } = await registerWithHome();
    await postOk(token, [snap(0, true, true), snap(5, false, false)]);
    await postOk(token, [snap(125, true, true)]);
    const [closed] = await outagesOf(homeId);
    expect(closed?.status).toBe('cerrado');
    now = at(3001);
    queries = 0;

    const body = await postOk(token, [confirmation(3000, 5, false)]);

    expect(body).toEqual({
      accepted: 1,
      duplicated: 0,
      status: { state: 'con_luz', since: at(125), alias: 'Casa', openOutageStart: null },
    });
    expect(queries).toBe(3);
    expect(await outagesOf(homeId)).toEqual([
      { ...closed, status: 'descartado', confirmed: false },
    ]);
  });

  it('más de 200 eventos responde 400 validation_failed', async () => {
    const { token, homeId } = await registerWithHome();
    const events = Array.from({ length: 201 }, (_, i) => snap(i, true, true));

    const res = await post(token, events);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('validation_failed');
    expect(queries).toBe(0);
    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.events WHERE home_id = ${homeId}`;
    expect(count?.n).toBe(0);
  });

  it('un lote de más de 256 KB responde 413 sin tocar la base', async () => {
    const { token } = await registerWithHome();
    const batch = {
      sentAt: now,
      diagnostics: DIAGNOSTICS,
      events: [],
      relleno: 'x'.repeat(300_000),
    };

    const res = await call('POST', '/v1/events', token, batch);

    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'validation_failed',
    );
    expect(queries).toBe(0);
  });

  it('cada clasificación deja en el log el tamaño de la ventana, sin el token', async () => {
    const { token, homeId } = await registerWithHome();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await postOk(token, [snap(0, true, true), snap(5, false, false)]);

    expect(log).toHaveBeenCalledWith('clasificación', { homeId, window: 2 });
    expect(JSON.stringify(log.mock.calls)).not.toContain(token);
  });

  it('sin casa responde 404', async () => {
    const { token } = await register();
    queries = 0;

    const res = await post(token, [snap(0, true, true)]);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
    expect(queries).toBe(1);
    const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM app.events`;
    expect(count?.n).toBe(0);
  });

  it('un token firmado de un dispositivo borrado responde 401', async () => {
    const { token } = await registerWithHome();
    await call('DELETE', '/v1/devices/me', token);
    queries = 0;

    const res = await post(token, [snap(0, true, true)]);

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_token');
    expect(queries).toBe(1);
  });

  it('un lote que autenticó antes de que otro aplicara deja la casa en con_luz', async () => {
    const { token, deviceId, homeId } = await registerWithHome();
    // B autentica aquí: ve la casa en con_luz, antes de que A abra el corte
    const created = await homeRow(homeId);
    const stale = {
      mode: 'base' as const,
      state: 'con_luz' as const,
      since: created?.since ?? 0,
      alias: 'Casa',
      openOutageStart: null,
    };
    const a = await postOk(token, [snap(0, true, true), snap(5, false, false)]);
    expect(a.status.state).toBe('sin_luz');
    now = at(130);
    queries = 0;

    const counted = testDb({ onQuery: () => queries++ }).sql;
    const { response: body, notify } = await ingestEvents(
      counted,
      { id: deviceId, homeId, home: stale },
      { sentAt: now, diagnostics: DIAGNOSTICS, events: [snap(125, true, true)] },
      now,
    ).finally(() => counted.end());

    expect(notify).toEqual([]); // nadie sigue la casa y el teléfono no tiene push_token
    expect(body).toEqual({
      accepted: 1,
      duplicated: 0,
      status: { state: 'con_luz', since: at(125), alias: 'Casa', openOutageStart: null },
    });
    expect(queries).toBe(2); // ingest_batch y apply_outages: la auth ya había corrido
    expect(await homeRow(homeId)).toEqual({ status: 'con_luz', since: at(125) });
    expect(await outagesOf(homeId)).toMatchObject([{ status: 'cerrado', end: at(125) }]);
  });

  it.each([50, 7, 1])(
    'el exporte real da los mismos cortes que classify (lotes de %i)',
    async (size) => {
      const exported = JSON.parse(
        readFileSync(
          new URL('../fixtures/exports/redmi-a5-2026-11-02.json', import.meta.url),
          'utf8',
        ),
      ) as { events: unknown[] };
      const events = exported.events.map((event) => deviceEventSchema.parse(event));
      const expected = classify(events, { mode: 'base' });
      expect(expected.length).toBeGreaterThan(0);
      const { token, homeId } = await registerWithHome();

      for (let i = 0; i < events.length; i += size) {
        const batch = events.slice(i, i + size);
        // sentAt igual a la hora de recepción: desfase 0, at queda igual que en el exporte
        now = Math.max(...batch.map((event) => event.at));
        queries = 0;
        const body = await postOk(token, batch);
        expect(body).toMatchObject({ accepted: batch.length, duplicated: 0 });
        expect(queries).toBe(3);
      }

      const stored = await outagesOf(homeId);
      expect(
        stored.map(({ start, end, status, confidence }) => ({ start, end, status, confidence })),
      ).toEqual(
        expected.map(({ start, end, status, confidence }) => ({ start, end, status, confidence })),
      );
    },
  );
});
