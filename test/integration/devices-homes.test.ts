import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Bindings, RateLimiter } from '../../src/env';
import { createApp } from '../../src/index';
import { sha256Hex, verifyToken } from '../../src/lib/crypto';
import { createHomeForDevice } from '../../src/modules/homes/service';
import { TEST_SIGNING_KEY, testDb, truncateAll } from './helpers';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHARE_CODE = /^[2-9A-HJKMNP-Z]{8}$/;

function limiter(allowed = Number.POSITIVE_INFINITY): RateLimiter {
  let calls = 0;
  return { limit: async () => ({ success: ++calls <= allowed }) };
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
    TOKEN_SIGNING_KEY: TEST_SIGNING_KEY,
    ...overrides,
  };
}

type Json = Record<string, unknown>;

describe('devices y homes', () => {
  const { sql } = testDb();
  let queries = 0;
  const app = createApp({ onQuery: () => queries++ });

  beforeEach(async () => {
    await truncateAll(sql);
    queries = 0;
  });

  afterAll(async () => {
    await sql.end();
  });

  function call(
    method: string,
    path: string,
    { token, body, env }: { token?: string; body?: unknown; env?: Partial<Bindings> } = {},
  ) {
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
      testEnv(env),
    );
  }

  async function register(appVersion = '1.0.0') {
    const res = await call('POST', '/v1/devices', { body: { appVersion } });
    expect(res.status).toBe(201);
    return (await res.json()) as { deviceId: string; token: string };
  }

  async function registerWithHome(body: Json = {}) {
    const device = await register();
    const res = await call('POST', '/v1/homes', { token: device.token, body });
    expect(res.status).toBe(201);
    const home = (await res.json()) as { homeId: string; shareCode: string };
    queries = 0;
    return { ...device, ...home };
  }

  it('registrar devuelve el token una sola vez y guarda su hash', async () => {
    const res = await call('POST', '/v1/devices', { body: { appVersion: '1.2.3' } });
    expect(res.status).toBe(201);
    const { deviceId, token } = (await res.json()) as { deviceId: string; token: string };
    expect(deviceId).toMatch(UUID_V7);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
    expect(await verifyToken(TEST_SIGNING_KEY, token)).toBe(true);

    const [row] = await sql<{ token_hash: string; as_text: string; app_version: string }[]>`
      SELECT token_hash, d::text AS as_text, app_version FROM app.devices d WHERE id = ${deviceId}`;
    expect(row?.token_hash).toBe(await sha256Hex(token));
    expect(row?.app_version).toBe('1.2.3');
    // ninguna columna contiene el token
    expect(row?.as_text).not.toContain(token);
    expect(queries).toBe(1);
  });

  it('registrar con appVersion vacío o de más de 32 caracteres responde 400', async () => {
    for (const appVersion of ['', 'x'.repeat(33)]) {
      const res = await call('POST', '/v1/devices', { body: { appVersion } });
      expect(res.status).toBe(400);
    }
    expect((await call('POST', '/v1/devices', { body: {} })).status).toBe(400);
  });

  it('registrar más de 5 veces por minuto desde una IP responde 429', async () => {
    const env = { RATE_LIMIT_REGISTER: limiter(5) };
    for (let i = 0; i < 5; i++) {
      const res = await call('POST', '/v1/devices', { body: { appVersion: '1.0.0' }, env });
      expect(res.status).toBe(201);
    }
    const res = await call('POST', '/v1/devices', { body: { appVersion: '1.0.0' }, env });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    const [count] = await sql<{ n: string }[]>`SELECT count(*) AS n FROM app.devices`;
    expect(count?.n).toBe('5');
  });

  it('crear la casa la asigna al dispositivo', async () => {
    const device = await register();
    const before = Date.now();
    queries = 0;
    const res = await call('POST', '/v1/homes', { token: device.token, body: {} });

    expect(res.status).toBe(201);
    const { homeId, shareCode } = (await res.json()) as { homeId: string; shareCode: string };
    expect(homeId).toMatch(UUID_V7);
    expect(shareCode).toMatch(SHARE_CODE);
    expect(queries).toBe(2); // auth + el CTE que crea y asigna

    const [home] = await sql<
      {
        share_code: string;
        alias: string;
        mode: string;
        status: string;
        status_since: string;
        created_at: string;
      }[]
    >`SELECT share_code, alias, mode, status, status_since, created_at FROM app.homes WHERE id = ${homeId}`;
    expect(home).toMatchObject({
      share_code: shareCode,
      alias: 'Casa',
      mode: 'base',
      status: 'con_luz',
    });
    expect(Number(home?.created_at)).toBeGreaterThanOrEqual(before);
    expect(home?.status_since).toBe(home?.created_at);
    const [row] = await sql<{ home_id: string }[]>`
      SELECT home_id FROM app.devices WHERE id = ${device.deviceId}`;
    expect(row?.home_id).toBe(homeId);
  });

  it('el alias se recorta y se valida entre 1 y 40 caracteres', async () => {
    const device = await register();
    for (const alias of ['', '   ', 'x'.repeat(41)]) {
      const res = await call('POST', '/v1/homes', { token: device.token, body: { alias } });
      expect(res.status).toBe(400);
    }
    const res = await call('POST', '/v1/homes', {
      token: device.token,
      body: { alias: '  Casa de mamá  ' },
    });
    expect(res.status).toBe(201);
    const { homeId } = (await res.json()) as { homeId: string };
    const [home] = await sql<{ alias: string }[]>`SELECT alias FROM app.homes WHERE id = ${homeId}`;
    expect(home?.alias).toBe('Casa de mamá');
  });

  it('una segunda casa responde 409 home_exists', async () => {
    const first = await registerWithHome();
    const res = await call('POST', '/v1/homes', { token: first.token, body: {} });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('home_exists');
    expect(queries).toBe(1); // solo la auth
    const [count] = await sql<{ n: string }[]>`SELECT count(*) AS n FROM app.homes`;
    expect(count?.n).toBe('1');
  });

  it('el estado de una casa nueva es con_luz', async () => {
    const { token, homeId } = await registerWithHome();
    const [home] = await sql<{ created_at: string }[]>`
      SELECT created_at FROM app.homes WHERE id = ${homeId}`;

    const res = await call('GET', '/v1/homes/me/status', { token });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      state: 'con_luz',
      since: Number(home?.created_at),
      alias: 'Casa',
      openOutageStart: null,
    });
    expect(queries).toBe(1);
  });

  it('cambiar el modo a ups se guarda', async () => {
    const { token, homeId } = await registerWithHome();
    const res = await call('PATCH', '/v1/homes/me', { token, body: { mode: 'ups' } });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    const [home] = await sql<{ mode: string; alias: string }[]>`
      SELECT mode, alias FROM app.homes WHERE id = ${homeId}`;
    expect(home).toEqual({ mode: 'ups', alias: 'Casa' });

    const renamed = await call('PATCH', '/v1/homes/me', { token, body: { alias: ' Oficina ' } });
    expect(renamed.status).toBe(204);
    const [after] = await sql<{ mode: string; alias: string }[]>`
      SELECT mode, alias FROM app.homes WHERE id = ${homeId}`;
    expect(after).toEqual({ mode: 'ups', alias: 'Oficina' });
  });

  it('PATCH de la casa rechaza un modo desconocido y un cuerpo sin campos', async () => {
    const { token } = await registerWithHome();
    expect((await call('PATCH', '/v1/homes/me', { token, body: { mode: 'solar' } })).status).toBe(
      400,
    );
    expect((await call('PATCH', '/v1/homes/me', { token, body: {} })).status).toBe(400);
  });

  it('sin casa, status y PATCH de la casa responden 404', async () => {
    const { token } = await register();
    const status = await call('GET', '/v1/homes/me/status', { token });
    expect(status.status).toBe(404);
    expect(((await status.json()) as { error: { code: string } }).error.code).toBe('not_found');
    queries = 0;
    const patch = await call('PATCH', '/v1/homes/me', { token, body: { mode: 'ups' } });
    expect(patch.status).toBe(404);
    expect(queries).toBe(1); // solo la auth
  });

  it('PATCH del dispositivo guarda el push token y la versión, y acepta null', async () => {
    const { token, deviceId } = await register();
    const read = async () => {
      const [row] = await sql<{ push_token: string | null; app_version: string }[]>`
        SELECT push_token, app_version FROM app.devices WHERE id = ${deviceId}`;
      return row;
    };

    const set = await call('PATCH', '/v1/devices/me', {
      token,
      body: { pushToken: 'ExponentPushToken[abc]', appVersion: '1.1.0' },
    });
    expect(set.status).toBe(204);
    expect(await read()).toEqual({ push_token: 'ExponentPushToken[abc]', app_version: '1.1.0' });

    const onlyVersion = await call('PATCH', '/v1/devices/me', {
      token,
      body: { appVersion: '1.2.0' },
    });
    expect(onlyVersion.status).toBe(204);
    expect(await read()).toEqual({ push_token: 'ExponentPushToken[abc]', app_version: '1.2.0' });

    const cleared = await call('PATCH', '/v1/devices/me', { token, body: { pushToken: null } });
    expect(cleared.status).toBe(204);
    expect(await read()).toEqual({ push_token: null, app_version: '1.2.0' });
  });

  it('PATCH del dispositivo sin campos responde 400', async () => {
    const { token } = await register();
    expect((await call('PATCH', '/v1/devices/me', { token, body: {} })).status).toBe(400);
  });

  it('las rutas con token responden 401 sin él', async () => {
    for (const [method, path, body] of [
      ['PATCH', '/v1/devices/me', { appVersion: '1' }],
      ['DELETE', '/v1/devices/me', undefined],
      ['POST', '/v1/homes', {}],
      ['PATCH', '/v1/homes/me', { mode: 'ups' }],
      ['GET', '/v1/homes/me/status', undefined],
    ] as const) {
      const res = await call(method, path, { body });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    expect(queries).toBe(0);
  });

  it('borrar el dispositivo borra su casa y todo lo asociado', async () => {
    const { token, deviceId, homeId } = await registerWithHome();
    const follower = await register();
    const now = Date.now();
    await sql`
      INSERT INTO app.events (device_id, id, home_id, kind, device_at, at, payload, received_at)
      VALUES (${deviceId}, ${randomUUID()}, ${homeId}, 'report', ${now}, ${now}, '{}'::jsonb, ${now})`;
    await sql`
      INSERT INTO app.outages (id, home_id, started_at, status, confidence, updated_at)
      VALUES (${randomUUID()}, ${homeId}, ${now}, 'abierto', 'alta', ${now})`;
    await sql`
      INSERT INTO app.follows (home_id, follower_device_id, alias, created_at)
      VALUES (${homeId}, ${follower.deviceId}, 'Casa de mamá', ${now})`;
    await sql`
      INSERT INTO app.push_tickets (ticket_id, device_id, created_at)
      VALUES ('ticket-1', ${deviceId}, ${now})`;

    const res = await call('DELETE', '/v1/devices/me', { token });

    expect(res.status).toBe(204);
    const count = async (table: string, column: string, id: string) => {
      const [row] = await sql<{ n: string }[]>`
        SELECT count(*) AS n FROM ${sql(`app.${table}`)} WHERE ${sql(column)} = ${id}`;
      return Number(row?.n);
    };
    expect(await count('homes', 'id', homeId)).toBe(0);
    expect(await count('devices', 'id', deviceId)).toBe(0);
    expect(await count('events', 'home_id', homeId)).toBe(0);
    expect(await count('events', 'device_id', deviceId)).toBe(0);
    expect(await count('outages', 'home_id', homeId)).toBe(0);
    expect(await count('follows', 'home_id', homeId)).toBe(0);
    expect(await count('push_tickets', 'device_id', deviceId)).toBe(0);
    // el seguidor sigue existiendo: solo se fue la casa
    expect(await count('devices', 'id', follower.deviceId)).toBe(1);

    const again = await call('GET', '/v1/homes/me/status', { token });
    expect(again.status).toBe(401);
  });

  it('borrar un dispositivo sin casa borra solo el dispositivo', async () => {
    const { token, deviceId } = await register();
    const res = await call('DELETE', '/v1/devices/me', { token });
    expect(res.status).toBe(204);
    const [row] = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM app.devices WHERE id = ${deviceId}`;
    expect(row?.n).toBe('0');
  });

  describe('código para compartir', () => {
    async function deviceWithoutHome() {
      const { deviceId } = await register();
      return { id: deviceId, homeId: null, home: null };
    }

    it('si el código choca, reintenta con otro', async () => {
      const taken = await registerWithHome();
      const device = await deviceWithoutHome();
      const codes = [taken.shareCode, taken.shareCode, 'ZZZZZZZZ'];
      const created = await createHomeForDevice(sql, device, 'Casa', Date.now(), () => {
        const code = codes.shift();
        if (!code) throw new Error('se pidieron más códigos de los esperados');
        return code;
      });
      expect(created?.shareCode).toBe('ZZZZZZZZ');
      expect(codes).toEqual([]);
    });

    it('si choca 3 veces, falla y no deja una casa huérfana', async () => {
      const taken = await registerWithHome();
      const device = await deviceWithoutHome();
      await expect(
        createHomeForDevice(sql, device, 'Casa', Date.now(), () => taken.shareCode),
      ).rejects.toMatchObject({ code: '23505' });
      const [homes] = await sql<{ n: string }[]>`SELECT count(*) AS n FROM app.homes`;
      expect(homes?.n).toBe('1');
      const [row] = await sql<{ home_id: string | null }[]>`
        SELECT home_id FROM app.devices WHERE id = ${device.id}`;
      expect(row?.home_id).toBeNull();
    });

    it('si otra petición ya asignó la casa, no crea una huérfana', async () => {
      const first = await registerWithHome();
      // el estado que vio la petición era viejo: ya no tenía casa
      const stale = { id: first.deviceId, homeId: null, home: null };
      const created = await createHomeForDevice(sql, stale, 'Casa', Date.now());
      expect(created).toBeNull();
      const [homes] = await sql<{ n: string }[]>`SELECT count(*) AS n FROM app.homes`;
      expect(homes?.n).toBe('1');
    });
  });
});
