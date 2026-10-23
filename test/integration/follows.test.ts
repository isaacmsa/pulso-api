import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Bindings, RateLimiter } from '../../src/env';
import { createApp } from '../../src/index';
import { regenerateShareCode } from '../../src/modules/homes/service';
import { TEST_SIGNING_KEY, testDb, truncateAll } from './helpers';

const SHARE_CODE = /^[2-9A-HJKMNP-Z]{8}$/;
const NOW = Date.UTC(2026, 9, 21, 18, 0);

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

type FollowBody = {
  homeId: string;
  alias: string;
  status: { state: string; since: number; alias: string; openOutageStart: number | null };
};

describe('follows y share-code', () => {
  const { sql } = testDb();
  let queries = 0;
  const app = createApp({ onQuery: () => queries++, now: () => NOW });

  beforeEach(async () => {
    await truncateAll(sql);
    queries = 0;
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

  async function registerWithHome(alias = 'Casa') {
    const device = await register();
    const res = await call('POST', '/v1/homes', device.token, { alias });
    expect(res.status).toBe(201);
    const home = (await res.json()) as { homeId: string; shareCode: string };
    queries = 0;
    return { ...device, ...home };
  }

  async function follow(token: string, code: string, alias = 'Casa de mamá') {
    queries = 0;
    return call('POST', '/v1/follows', token, { code, alias });
  }

  async function followOk(token: string, code: string, alias = 'Casa de mamá') {
    const res = await follow(token, code, alias);
    expect(res.status).toBe(201);
    return (await res.json()) as FollowBody;
  }

  async function followCount(deviceId?: string) {
    const [row] = deviceId
      ? await sql<{ n: string }[]>`
          SELECT count(*) AS n FROM app.follows WHERE follower_device_id = ${deviceId}`
      : await sql<{ n: string }[]>`SELECT count(*) AS n FROM app.follows`;
    return Number(row?.n);
  }

  /** Una casa que sigue el teléfono con ese token y otras `n - 1` casas más, con SQL directo. */
  async function followManyHomes(deviceId: string, n: number) {
    const homeIds: string[] = [];
    for (let i = 0; i < n; i++) {
      const homeId = randomUUID();
      homeIds.push(homeId);
      await sql`
        INSERT INTO app.homes (id, share_code, alias, status_since, created_at)
        VALUES (${homeId}, ${`AAAAAAA${'ABCDEFGHJKMNPQRSTUVW'[i]}`}, ${`Casa ${i}`}, 0, 0)`;
      await sql`
        INSERT INTO app.follows (home_id, follower_device_id, alias, created_at)
        VALUES (${homeId}, ${deviceId}, ${`Alias ${i}`}, 0)`;
    }
    return homeIds;
  }

  describe('POST /v1/follows', () => {
    it('seguir con un código válido devuelve el estado de la casa', async () => {
      const owner = await registerWithHome('Casa del dueño');
      const follower = await register();

      const body = await followOk(follower.token, owner.shareCode, 'Casa de mamá');

      expect(body).toEqual({
        homeId: owner.homeId,
        alias: 'Casa de mamá',
        status: { state: 'con_luz', since: NOW, alias: 'Casa del dueño', openOutageStart: null },
      });
      expect(queries).toBe(2); // la auth y un CTE
      expect(await followCount(follower.deviceId)).toBe(1);
    });

    it('con un corte abierto, el estado trae sin_luz y cuándo empezó', async () => {
      const owner = await registerWithHome();
      const follower = await register();
      const start = NOW - 3_600_000;
      await sql`UPDATE app.homes SET status = 'sin_luz', status_since = ${start} WHERE id = ${owner.homeId}`;
      await sql`
        INSERT INTO app.outages (id, home_id, started_at, status, confidence, updated_at)
        VALUES (${randomUUID()}, ${owner.homeId}, ${start}, 'abierto', 'alta', ${start})`;

      const body = await followOk(follower.token, owner.shareCode);

      expect(body.status).toMatchObject({
        state: 'sin_luz',
        since: start,
        openOutageStart: start,
      });
    });

    it('seguir dos veces actualiza el alias y no duplica', async () => {
      const owner = await registerWithHome();
      const follower = await register();

      await followOk(follower.token, owner.shareCode, 'Casa de mamá');
      const second = await followOk(follower.token, owner.shareCode, 'Mamá');

      expect(second.alias).toBe('Mamá');
      expect(await followCount(follower.deviceId)).toBe(1);
      const [row] = await sql<{ alias: string; created_at: string }[]>`
        SELECT alias, created_at FROM app.follows WHERE follower_device_id = ${follower.deviceId}`;
      expect(row?.alias).toBe('Mamá');
    });

    it('un código en minúsculas se acepta', async () => {
      const owner = await registerWithHome();
      const follower = await register();

      const body = await followOk(follower.token, owner.shareCode.toLowerCase());

      expect(body.homeId).toBe(owner.homeId);
    });

    it('el alias se recorta y el código con espacios no se acepta', async () => {
      const owner = await registerWithHome();
      const follower = await register();

      expect((await followOk(follower.token, owner.shareCode, '  Mamá  ')).alias).toBe('Mamá');
      expect((await follow(follower.token, ` ${owner.shareCode}`)).status).toBe(400);
    });

    it('un código que no existe responde 404', async () => {
      await registerWithHome();
      const follower = await register();

      const res = await follow(follower.token, 'ZZZZZZZZ');

      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
      expect(queries).toBe(2);
      expect(await followCount()).toBe(0);
    });

    it('un código mal formado responde 400 sin tocar la base más que en la auth', async () => {
      const follower = await register();
      // corto, largo, con letras fuera del alfabeto (0, 1, I, L, O) o con símbolos
      for (const code of ['ABC', 'ABCDEFGHJ', 'ABCDEFG0', 'ABCDEFGI', 'ABCDEFGO', 'ABCD-EFG']) {
        const res = await follow(follower.token, code);
        expect(res.status, code).toBe(400);
        expect(queries, code).toBe(1);
      }
    });

    it('un alias vacío o de más de 40 caracteres responde 400, y sin cuerpo JSON también', async () => {
      const owner = await registerWithHome();
      const follower = await register();
      for (const alias of ['', '   ', 'x'.repeat(41)]) {
        expect((await follow(follower.token, owner.shareCode, alias)).status).toBe(400);
      }
      const noAlias = await call('POST', '/v1/follows', follower.token, { code: owner.shareCode });
      expect(noAlias.status).toBe(400);
      const noBody = await call('POST', '/v1/follows', follower.token);
      expect(noBody.status).toBe(400);
      expect(await followCount()).toBe(0);
    });

    it('sin token responde 401', async () => {
      expect(
        (await call('POST', '/v1/follows', undefined, { code: 'ABCDEFGH', alias: 'x' })).status,
      ).toBe(401);
    });

    it('seguir la propia casa se permite', async () => {
      const owner = await registerWithHome();

      const body = await followOk(owner.token, owner.shareCode, 'La mía');

      expect(body.homeId).toBe(owner.homeId);
    });

    it('la casa 21 responde 400', async () => {
      const owner = await registerWithHome();
      const follower = await register();
      await followManyHomes(follower.deviceId, 20);

      const res = await follow(follower.token, owner.shareCode);

      expect(res.status).toBe(400);
      const { error } = (await res.json()) as { error: { code: string; message: string } };
      expect(error.code).toBe('validation_failed');
      expect(error.message).toBe('Ya sigues 20 casas.'); // no es un error de forma
      expect(queries).toBe(2);
      expect(await followCount(follower.deviceId)).toBe(20);
    });

    it('con 20 casas, volver a seguir una de ellas sí actualiza el alias', async () => {
      const follower = await register();
      const [first] = await followManyHomes(follower.deviceId, 20);
      const [home] = await sql<{ share_code: string }[]>`
        SELECT share_code FROM app.homes WHERE id = ${first as string}`;

      const body = await followOk(follower.token, home?.share_code as string, 'Nuevo alias');

      expect(body.alias).toBe('Nuevo alias');
      expect(await followCount(follower.deviceId)).toBe(20);
    });

    it('el tope de 20 es por dispositivo: otro teléfono puede seguir la misma casa', async () => {
      const owner = await registerWithHome();
      const full = await register();
      await followManyHomes(full.deviceId, 20);
      const other = await register();

      await followOk(other.token, owner.shareCode);
      expect(await followCount(other.deviceId)).toBe(1);
    });
  });

  describe('GET /v1/follows', () => {
    it('la lista trae cada casa con su estado, ordenada por alias', async () => {
      const homeA = await registerWithHome('Casa A');
      const homeB = await registerWithHome('Casa B');
      const follower = await register();
      await followOk(follower.token, homeA.shareCode, 'Zulia');
      await followOk(follower.token, homeB.shareCode, 'Abuela');
      await sql`UPDATE app.homes SET status = 'sin_noticias', status_since = 5000 WHERE id = ${homeB.homeId}`;
      queries = 0;

      const res = await call('GET', '/v1/follows', follower.token);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        items: [
          {
            homeId: homeB.homeId,
            alias: 'Abuela',
            status: { state: 'sin_noticias', since: 5000, alias: 'Casa B', openOutageStart: null },
          },
          {
            homeId: homeA.homeId,
            alias: 'Zulia',
            status: { state: 'con_luz', since: NOW, alias: 'Casa A', openOutageStart: null },
          },
        ],
      });
      expect(queries).toBe(2);
    });

    it('trae el corte abierto de cada casa', async () => {
      const owner = await registerWithHome();
      const follower = await register();
      await followOk(follower.token, owner.shareCode);
      const start = NOW - 600_000;
      await sql`UPDATE app.homes SET status = 'sin_luz', status_since = ${start} WHERE id = ${owner.homeId}`;
      await sql`
        INSERT INTO app.outages (id, home_id, started_at, status, confidence, updated_at)
        VALUES (${randomUUID()}, ${owner.homeId}, ${start}, 'abierto', 'alta', ${start})`;

      const res = await call('GET', '/v1/follows', follower.token);

      const { items } = (await res.json()) as { items: FollowBody[] };
      expect(items[0]?.status).toMatchObject({ state: 'sin_luz', openOutageStart: start });
    });

    it('sin follows devuelve una lista vacía, y solo trae los míos', async () => {
      const owner = await registerWithHome();
      const mine = await register();
      const other = await register();
      await followOk(other.token, owner.shareCode);

      const res = await call('GET', '/v1/follows', mine.token);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ items: [] });
    });

    it('sin token responde 401', async () => {
      expect((await call('GET', '/v1/follows')).status).toBe(401);
    });
  });

  describe('DELETE /v1/follows/:homeId', () => {
    it('dejar de seguir la quita de la lista', async () => {
      const owner = await registerWithHome();
      const follower = await register();
      await followOk(follower.token, owner.shareCode);
      queries = 0;

      const res = await call('DELETE', `/v1/follows/${owner.homeId}`, follower.token);

      expect(res.status).toBe(204);
      expect(queries).toBe(2); // la auth y el DELETE
      const list = await call('GET', '/v1/follows', follower.token);
      expect(await list.json()).toEqual({ items: [] });
    });

    it('responde 204 también si no la seguía, o si la casa no existe', async () => {
      const owner = await registerWithHome();
      const follower = await register();

      expect((await call('DELETE', `/v1/follows/${owner.homeId}`, follower.token)).status).toBe(
        204,
      );
      expect((await call('DELETE', `/v1/follows/${randomUUID()}`, follower.token)).status).toBe(
        204,
      );
    });

    it('un dispositivo no puede quitar el follow de otro', async () => {
      const owner = await registerWithHome();
      const mama = await register();
      const papa = await register();
      await followOk(mama.token, owner.shareCode);
      await followOk(papa.token, owner.shareCode);

      const res = await call('DELETE', `/v1/follows/${owner.homeId}`, papa.token);

      expect(res.status).toBe(204);
      expect(await followCount(papa.deviceId)).toBe(0);
      expect(await followCount(mama.deviceId)).toBe(1);
    });

    it('un homeId que no es uuid responde 400', async () => {
      const follower = await register();
      expect((await call('DELETE', '/v1/follows/no-es-uuid', follower.token)).status).toBe(400);
    });

    it('sin token responde 401', async () => {
      expect((await call('DELETE', `/v1/follows/${randomUUID()}`)).status).toBe(401);
    });
  });

  describe('POST /v1/homes/me/share-code', () => {
    it('regenerar el código invalida el viejo y quita a todos los seguidores', async () => {
      const owner = await registerWithHome();
      const mama = await register();
      const papa = await register();
      await followOk(mama.token, owner.shareCode);
      await followOk(papa.token, owner.shareCode);
      // un follow de otra casa no se toca
      const other = await registerWithHome('Otra');
      await followOk(mama.token, other.shareCode, 'Otra casa');
      queries = 0;

      const res = await call('POST', '/v1/homes/me/share-code', owner.token);

      expect(res.status).toBe(200);
      const { shareCode } = (await res.json()) as { shareCode: string };
      expect(shareCode).toMatch(SHARE_CODE);
      expect(shareCode).not.toBe(owner.shareCode);
      expect(queries).toBe(2); // la auth y un solo statement

      // el viejo ya no sirve y nadie sigue la casa
      expect((await follow(papa.token, owner.shareCode)).status).toBe(404);
      const [row] = await sql<{ n: string }[]>`
        SELECT count(*) AS n FROM app.follows WHERE home_id = ${owner.homeId}`;
      expect(row?.n).toBe('0');
      const list = (await (await call('GET', '/v1/follows', mama.token)).json()) as {
        items: FollowBody[];
      };
      expect(list.items.map((i) => i.homeId)).toEqual([other.homeId]);
      // el nuevo sirve, y vuelve a seguirse
      expect((await follow(papa.token, shareCode)).status).toBe(201);
      const [home] = await sql<{ share_code: string }[]>`
        SELECT share_code FROM app.homes WHERE id = ${owner.homeId}`;
      expect(home?.share_code).toBe(shareCode);
    });

    it('un dispositivo sin casa responde 404', async () => {
      const device = await register();
      const res = await call('POST', '/v1/homes/me/share-code', device.token);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
    });

    it('sin token responde 401', async () => {
      expect((await call('POST', '/v1/homes/me/share-code')).status).toBe(401);
    });

    it('si el código nuevo choca, reintenta con otro y los seguidores se quitan una sola vez', async () => {
      const taken = await registerWithHome('Ocupada');
      const owner = await registerWithHome('Mía');
      const follower = await register();
      await followOk(follower.token, owner.shareCode);
      const codes = [taken.shareCode, 'ZZZZZZZZ'];
      let calls = 0;

      const code = await regenerateShareCode(sql, owner.homeId, () => {
        calls++;
        const next = codes.shift();
        if (!next) throw new Error('se pidieron más códigos de los esperados');
        return next;
      });

      expect(code).toBe('ZZZZZZZZ');
      expect(calls).toBe(2);
      expect(await followCount()).toBe(0);
    });

    it('si choca 3 veces, falla y no quita a nadie ni cambia el código', async () => {
      const taken = await registerWithHome('Ocupada');
      const owner = await registerWithHome('Mía');
      const follower = await register();
      await followOk(follower.token, owner.shareCode);

      await expect(
        regenerateShareCode(sql, owner.homeId, () => taken.shareCode),
      ).rejects.toMatchObject({ code: '23505' });

      expect(await followCount()).toBe(1);
      const [home] = await sql<{ share_code: string }[]>`
        SELECT share_code FROM app.homes WHERE id = ${owner.homeId}`;
      expect(home?.share_code).toBe(owner.shareCode);
    });

    it('una casa que ya no existe devuelve null y no borra follows de nadie', async () => {
      const owner = await registerWithHome();
      const follower = await register();
      await followOk(follower.token, owner.shareCode);

      expect(await regenerateShareCode(sql, randomUUID())).toBeNull();
      expect(await followCount()).toBe(1);
    });
  });

  describe('borrado', () => {
    it('borrar el dispositivo seguidor borra sus follows', async () => {
      const owner = await registerWithHome();
      const follower = await register();
      await followOk(follower.token, owner.shareCode);
      expect(await followCount()).toBe(1);

      const res = await call('DELETE', '/v1/devices/me', follower.token);

      expect(res.status).toBe(204);
      expect(await followCount()).toBe(0);
      const [home] = await sql<{ n: string }[]>`
        SELECT count(*) AS n FROM app.homes WHERE id = ${owner.homeId}`;
      expect(home?.n).toBe('1'); // la casa del otro sigue ahí
    });

    it('borrar el dispositivo de la casa borra los follows de sus seguidores', async () => {
      const owner = await registerWithHome();
      const follower = await register();
      await followOk(follower.token, owner.shareCode);

      await call('DELETE', '/v1/devices/me', owner.token);

      expect(await followCount()).toBe(0);
      const list = await call('GET', '/v1/follows', follower.token);
      expect(await list.json()).toEqual({ items: [] });
    });
  });
});
