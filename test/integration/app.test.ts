import { randomUUID } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings, RateLimiter } from '../../src/env';
import { createApp } from '../../src/index';
import { generateToken, sha256Hex } from '../../src/lib/crypto';
import { authenticate, requireDevice, requireToken } from '../../src/middleware/auth';
import { rateLimit } from '../../src/middleware/rate-limit';
import { createHome, testDb, truncateAll } from './helpers';

const NOW = 1_700_000_000_000; // en el pasado: requireDevice usa la hora real
const token = generateToken();
const bearer = { Authorization: `Bearer ${token}` };

function limiter(success = true): RateLimiter & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    limit: async ({ key }) => {
      keys.push(key);
      return { success };
    },
  };
}

function testEnv(overrides: Partial<Bindings> = {}): Bindings {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('Falta TEST_DATABASE_URL');
  return {
    HYPERDRIVE: { connectionString: url },
    RATE_LIMIT_REGISTER: limiter(),
    RATE_LIMIT_EVENTS: limiter(),
    RATE_LIMIT_API: limiter(),
    ENVIRONMENT: 'test',
    ...overrides,
  };
}

const probeBody = createRoute({
  method: 'post',
  path: '/__probe-body',
  request: {
    body: { content: { 'application/json': { schema: z.object({ n: z.number().int() }) } } },
  },
  responses: { 200: { description: 'ok' } },
});

/** La app real más rutas que solo existen en los tests. */
function appForTest(options: { onQuery?: () => void } = {}) {
  const app = createApp(options);
  app.get('/__probe', requireToken, rateLimit('RATE_LIMIT_API', 'token'), requireDevice, (c) =>
    c.json({ device: c.var.device }),
  );
  app.get('/__boom', () => {
    throw new Error(`boom ${token}`);
  });
  app.openapi(probeBody, (c) => c.json({ n: c.req.valid('json').n }, 200));
  return app;
}

describe('worker', () => {
  const { sql } = testDb();

  beforeEach(async () => {
    await truncateAll(sql);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await sql.end();
  });

  /** Crea una casa cuyo teléfono tiene `token`. */
  async function homeWithToken(): Promise<{ homeId: string; deviceId: string }> {
    const home = await createHome(sql, { since: NOW - 60_000 });
    await sql`UPDATE app.devices SET token_hash = ${await sha256Hex(token)} WHERE id = ${home.deviceId}`;
    return home;
  }

  it('health responde ok', async () => {
    const res = await appForTest().request('/health', {}, testEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('sin token responde 401 sin tocar la base', async () => {
    let queries = 0;
    const app = appForTest({ onQuery: () => queries++ });
    const res = await app.request('/__probe', {}, testEnv());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: 'invalid_token', message: expect.any(String) },
    });
    expect(queries).toBe(0);
  });

  it('un token desconocido responde 401', async () => {
    const res = await appForTest().request('/__probe', { headers: bearer }, testEnv());
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_token');
  });

  it('el límite responde 429 con Retry-After', async () => {
    let queries = 0;
    const api = limiter(false);
    const app = appForTest({ onQuery: () => queries++ });
    const res = await app.request(
      '/__probe',
      { headers: bearer },
      testEnv({ RATE_LIMIT_API: api }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
    // la clave es el hash del token y el límite corre antes de tocar la base
    expect(api.keys).toEqual([await sha256Hex(token)]);
    expect(queries).toBe(0);
  });

  it('un token válido autentica en una consulta y trae el resumen de la casa', async () => {
    const home = await homeWithToken();
    await sql`
      INSERT INTO app.outages (id, home_id, started_at, status, confidence, updated_at)
      VALUES (${randomUUID()}, ${home.homeId}, ${NOW - 30_000}, 'abierto', 'alta', ${NOW})`;
    let queries = 0;
    const app = appForTest({ onQuery: () => queries++ });

    const before = Date.now();
    const res = await app.request('/__probe', { headers: bearer }, testEnv());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      device: {
        id: home.deviceId,
        homeId: home.homeId,
        home: {
          mode: 'base',
          state: 'con_luz',
          since: NOW - 60_000,
          alias: 'Casa',
          openOutageStart: NOW - 30_000,
        },
      },
    });
    expect(queries).toBe(1);
    const [device] = await sql<{ last_seen_at: string }[]>`
      SELECT last_seen_at FROM app.devices WHERE id = ${home.deviceId}`;
    expect(Number(device?.last_seen_at)).toBeGreaterThanOrEqual(before);
  });

  it('authenticate guarda los diagnósticos en la misma consulta', async () => {
    const home = await homeWithToken();
    await sql`UPDATE app.devices SET home_id = NULL WHERE id = ${home.deviceId}`;
    const diagnostics = {
      appVersion: '1.0.0',
      manufacturer: 'Xiaomi',
      model: '25028RN03L',
      sdkInt: 35,
      standbyBucket: 10,
      ignoringBatteryOptimizations: true,
      pendingEvents: 0,
    };
    let queries = 0;
    const db = testDb({ onQuery: () => queries++ });
    try {
      // dos veces: la segunda corre la consulta ya preparada (la trampa de sql.json)
      await authenticate(db.sql, await sha256Hex(token), NOW, diagnostics);
      const device = await authenticate(db.sql, await sha256Hex(token), NOW + 1, diagnostics);
      expect(device).toEqual({ id: home.deviceId, homeId: null, home: null });
    } finally {
      await db.sql.end();
    }
    expect(queries).toBe(2);
    const [row] = await sql<{ diagnostics: unknown; last_seen_at: string }[]>`
      SELECT diagnostics, last_seen_at FROM app.devices WHERE id = ${home.deviceId}`;
    expect(row?.diagnostics).toEqual(diagnostics);
    expect(Number(row?.last_seen_at)).toBe(NOW + 1);
  });

  it('un cuerpo inválido responde 400 validation_failed con issues', async () => {
    const res = await appForTest().request(
      '/__probe-body',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"n":"x"}' },
      testEnv(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; issues: unknown[] } };
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.issues.length).toBeGreaterThan(0);
  });

  it('un cuerpo que no es JSON responde 400 validation_failed', async () => {
    const res = await appForTest().request(
      '/__probe-body',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"n":' },
      testEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'validation_failed', message: expect.any(String), issues: [] },
    });
  });

  it('una ruta que no existe responde 404 not_found', async () => {
    const res = await appForTest().request('/nada', {}, testEnv());
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('un error interno no filtra el token ni el mensaje original', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await appForTest().request('/__boom', { headers: bearer }, testEnv());
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: { code: 'internal_error', message: expect.any(String) },
    });
    expect(text).not.toContain(token);
    expect(text).not.toContain('boom');
    // el log lleva el error, pero nunca el token
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain(token);
  });
});
