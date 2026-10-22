import { randomUUID } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings, RateLimiter } from '../../src/env';
import { createApp } from '../../src/index';
import { generateToken, sha256Hex } from '../../src/lib/crypto';
import { authenticate, requireDevice, requireToken } from '../../src/middleware/auth';
import { errorSchema } from '../../src/middleware/errors';
import { rateLimit } from '../../src/middleware/rate-limit';
import { createHome, OTHER_SIGNING_KEY, TEST_SIGNING_KEY, testDb, truncateAll } from './helpers';

const NOW = 1_700_000_000_000; // en el pasado: requireDevice usa la hora del Worker (Date.now: este app no la fija)
const token = await generateToken(TEST_SIGNING_KEY);
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
    RATE_LIMIT_PUBLIC: limiter(),
    ENVIRONMENT: 'test',
    TOKEN_SIGNING_KEY: TEST_SIGNING_KEY,
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
  app.get('/__http/:status', (c) => {
    throw new HTTPException(Number(c.req.param('status')) as 401);
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

  it('health responde ok con una consulta', async () => {
    let queries = 0;
    const res = await appForTest({ onQuery: () => queries++ }).request('/health', {}, testEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(queries).toBe(1);
  });

  it('health con más de 60 por minuto desde una IP responde 429 sin tocar la base', async () => {
    let queries = 0;
    const publicLimit = limiter(false);
    const res = await appForTest({ onQuery: () => queries++ }).request(
      '/health',
      { headers: { 'cf-connecting-ip': '203.0.113.7' } },
      testEnv({ RATE_LIMIT_PUBLIC: publicLimit }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
    expect(publicLimit.keys).toEqual(['203.0.113.7']);
    expect(queries).toBe(0);
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

  it('un Authorization mal formado no revuelve el log al taparlo', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await appForTest().request(
      '/__boom',
      { headers: { Authorization: 'Bearer e' } },
      testEnv(),
    );
    expect(res.status).toBe(500);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain('[token]');
    expect(logged).toContain('Error: boom');
  });

  it('un token bien formado sí se tapa en el log', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await appForTest().request('/__boom', { headers: bearer }, testEnv());
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain('[token]');
    expect(logged).not.toContain(token);
  });

  it.each([
    [401, 'invalid_token'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [413, 'validation_failed'],
  ] as const)(
    'una HTTPException %i responde con su estado y el código %s',
    async (status, code) => {
      const res = await appForTest().request(`/__http/${status}`, {}, testEnv());
      expect(res.status).toBe(status);
      // igual que el 429 del limitador
      if (status === 429) expect(res.headers.get('Retry-After')).toBe('60');
      expect(await res.json()).toEqual({ error: { code, message: expect.any(String) } });
    },
  );

  it('una HTTPException 5xx responde internal_error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await appForTest().request('/__http/503', {}, testEnv());
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('internal_error');
  });

  it('el esquema de error lista los códigos', () => {
    expect(errorSchema.shape.error.shape.code.options).toEqual([
      'validation_failed',
      'invalid_token',
      'not_found',
      'home_exists',
      'rate_limited',
      'internal_error',
    ]);
  });

  describe('firma del token', () => {
    const [random = '', sig = ''] = token.split('.');

    async function expectRejectedWithoutQuery(authorization: string, env?: Partial<Bindings>) {
      let queries = 0;
      const api = limiter();
      const app = appForTest({ onQuery: () => queries++ });
      const res = await app.request(
        '/__probe',
        { headers: { Authorization: authorization } },
        testEnv({ RATE_LIMIT_API: api, ...env }),
      );
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_token');
      expect(queries).toBe(0);
      expect(api.keys).toEqual([]); // ni siquiera llega al límite
    }

    it('un token con firma inválida no llega a la base', async () => {
      const flipped = `${sig.startsWith('A') ? 'B' : 'A'}${sig.slice(1)}`;
      await expectRejectedWithoutQuery(`Bearer ${random}.${flipped}`);
    });

    it('un token sin firma no llega a la base', async () => {
      await expectRejectedWithoutQuery(`Bearer ${random}`);
    });

    it('un token firmado con otra clave es rechazado', async () => {
      await expectRejectedWithoutQuery(`Bearer ${token}`, { TOKEN_SIGNING_KEY: OTHER_SIGNING_KEY });
    });

    it('una firma con otra escritura base64url es rechazada sin consultar la base', async () => {
      // 43 caracteres base64url llevan 258 bits: el último trae 2 bits que no cuentan, así que
      // hay 3 escrituras más de los mismos 256 bits
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      const last = alphabet.indexOf(sig.slice(-1));
      expect(last % 4).toBe(0); // la firma canónica termina en un carácter múltiplo de 4
      const respelled = `${sig.slice(0, -1)}${alphabet[last + 1]}`;
      await expectRejectedWithoutQuery(`Bearer ${random}.${respelled}`);
    });

    it('sin TOKEN_SIGNING_KEY responde 500 con un mensaje claro y sin consultar la base', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      let queries = 0;
      const app = appForTest({ onQuery: () => queries++ });
      const res = await app.request(
        '/__probe',
        { headers: bearer },
        testEnv({ TOKEN_SIGNING_KEY: undefined as unknown as string }),
      );
      expect(res.status).toBe(500);
      expect(queries).toBe(0);
      expect(JSON.stringify(log.mock.calls)).toContain('TOKEN_SIGNING_KEY');
    });

    it('un token válido de verdad autentica', async () => {
      await homeWithToken();
      const res = await appForTest().request('/__probe', { headers: bearer }, testEnv());
      expect(res.status).toBe(200);
    });
  });
});
