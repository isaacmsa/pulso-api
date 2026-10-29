import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Bindings, RateLimiter } from '../../src/env';
import { createApp } from '../../src/index';
import { TEST_SIGNING_KEY, testDb, truncateAll } from './helpers';

/** Una hora de Caracas (UTC−4) en epoch ms. */
const VET = (h: number, min = 0, day = 29) => Date.UTC(2026, 9, day, h + 4, min);
const NOW = VET(19, 25); // 29 oct, 7:25 p. m.

const CODE = 'K7M2QX9P';
const FINGERPRINT =
  '14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5';

const allow: RateLimiter = { limit: async () => ({ success: true }) };
const deny: RateLimiter = { limit: async () => ({ success: false }) };

function testEnv(overrides: Partial<Bindings> = {}): Bindings {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('Falta TEST_DATABASE_URL');
  return {
    HYPERDRIVE: { connectionString: url },
    RATE_LIMIT_REGISTER: allow,
    RATE_LIMIT_EVENTS: allow,
    RATE_LIMIT_API: allow,
    RATE_LIMIT_PUBLIC: allow,
    ENVIRONMENT: 'test',
    TOKEN_SIGNING_KEY: TEST_SIGNING_KEY,
    ...overrides,
  };
}

describe('página de la familia y App Links', () => {
  const { sql } = testDb();
  let queries = 0;
  const app = createApp({ onQuery: () => queries++, now: () => NOW });

  beforeEach(async () => {
    queries = 0;
    await truncateAll(sql);
  });
  afterAll(() => sql.end());

  async function seedHome(options: {
    alias?: string;
    status: 'con_luz' | 'sin_luz' | 'sin_noticias';
    since: number;
    openOutageStart?: number;
    code?: string;
  }) {
    const homeId = randomUUID();
    const deviceId = randomUUID();
    await sql`
      INSERT INTO app.homes (id, share_code, alias, status, status_since, created_at)
      VALUES (${homeId}, ${options.code ?? CODE}, ${options.alias ?? 'Casa de mamá'},
              ${options.status}, ${options.since}, 0)`;
    await sql`
      INSERT INTO app.devices (id, token_hash, home_id, app_version, push_token, created_at, last_seen_at)
      VALUES (${deviceId}, ${randomUUID()}, ${homeId}, '1.0.0', 'ExponentPushToken[secreto]', 0, 0)`;
    if (options.openOutageStart !== undefined) {
      await sql`
        INSERT INTO app.outages (id, home_id, started_at, status, confidence, updated_at)
        VALUES (${randomUUID()}, ${homeId}, ${options.openOutageStart}, 'abierto', 'alta', 0)`;
    }
    return { homeId, deviceId };
  }

  async function get(path: string, env: Bindings = testEnv()) {
    const res = await app.request(path, {}, env);
    return { res, html: await res.text() };
  }

  it('muestra Se fue la luz a las 6:05 p. m. con la duración', async () => {
    await seedHome({ status: 'sin_luz', since: VET(18, 5), openOutageStart: VET(18, 5) });
    const { res, html } = await get(`/c/${CODE}`);
    expect(res.status).toBe(200);
    expect(html).toContain('Casa de mamá');
    expect(html).toContain('Se fue la luz a las 6:05 p. m. (1 h 20 min)');
    expect(html).toContain('Abrir en Pulso');
    expect(html).toContain(`href="/c/${CODE}"`);
    expect(queries).toBe(1);
  });

  it('muestra Hay luz desde las 2:30 p. m.', async () => {
    await seedHome({ status: 'con_luz', since: VET(14, 30) });
    const { res, html } = await get(`/c/${CODE}`);
    expect(res.status).toBe(200);
    expect(html).toContain('Hay luz desde las 2:30 p. m.');
    expect(queries).toBe(1);
  });

  it('muestra Sin noticias de la casa desde las 7:10 p. m.', async () => {
    await seedHome({ status: 'sin_noticias', since: VET(19, 10) });
    const { html } = await get(`/c/${CODE}`);
    expect(html).toContain('Sin noticias de la casa desde las 7:10 p. m.');
  });

  it('un estado de otro día lleva la fecha, para que no se lea como de hoy', async () => {
    await seedHome({ status: 'con_luz', since: VET(14, 30, 28) });
    expect((await get(`/c/${CODE}`)).html).toContain('Hay luz desde el 28 oct a las 2:30 p. m.');
  });

  it('un corte de ayer lleva la fecha y la duración total', async () => {
    await seedHome({ status: 'sin_luz', since: VET(23, 30, 28), openOutageStart: VET(23, 30, 28) });
    expect((await get(`/c/${CODE}`)).html).toContain(
      'Se fue la luz el 28 oct a las 11:30 p. m. (19 h 55 min)',
    );
  });

  it('sin noticias de otro día también lleva la fecha', async () => {
    await seedHome({ status: 'sin_noticias', since: VET(19, 10, 27) });
    expect((await get(`/c/${CODE}`)).html).toContain(
      'Sin noticias de la casa desde el 27 oct a las 7:10 p. m.',
    );
  });

  it('pasada la medianoche de Caracas el estado de hoy no lleva fecha', async () => {
    await seedHome({ status: 'con_luz', since: VET(0, 30) });
    expect((await get(`/c/${CODE}`)).html).toContain('Hay luz desde las 12:30 a. m.');
  });

  it('el código en minúsculas encuentra la misma casa', async () => {
    await seedHome({ status: 'con_luz', since: VET(14, 30) });
    const { res, html } = await get(`/c/${CODE.toLowerCase()}`);
    expect(res.status).toBe(200);
    expect(html).toContain('Hay luz desde las 2:30 p. m.');
  });

  it('lleva las cabeceras de seguridad y de caché', async () => {
    await seedHome({ status: 'con_luz', since: VET(14, 30) });
    const { res } = await get(`/c/${CODE}`);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=30');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    );
  });

  it('un código que no existe da 404 sin datos', async () => {
    await seedHome({ status: 'con_luz', since: VET(14, 30), alias: 'Casa secreta' });
    const { res, html } = await get('/c/22222222');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(html).toContain('Ese código no existe');
    expect(html).not.toContain('Casa secreta');
    expect(queries).toBe(1);
  });

  it('un código inválido da el mismo 404 sin consultar la base', async () => {
    const unknown = await get('/c/22222222');
    for (const bad of ['ABC', 'K7M2QX9PX', 'K7M2QX90', 'K7M2QX9%20', 'K7M2QXIL']) {
      queries = 0;
      const { res, html } = await get(`/c/${bad}`);
      expect(res.status, bad).toBe(404);
      expect(html, bad).toBe(unknown.html);
      expect(res.headers.get('cache-control')).toBe(unknown.res.headers.get('cache-control'));
      expect(res.headers.get('x-robots-tag')).toBe('noindex');
      expect(queries, bad).toBe(0);
    }
  });

  it('el límite por IP responde 429 antes de consultar', async () => {
    await seedHome({ status: 'con_luz', since: VET(14, 30) });
    for (const code of [CODE, 'ABC']) {
      queries = 0;
      const { res } = await get(`/c/${code}`, testEnv({ RATE_LIMIT_PUBLIC: deny }));
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('60');
      expect(queries).toBe(0);
    }
  });

  it('el límite usa la IP del cliente', async () => {
    const keys: string[] = [];
    const spy: RateLimiter = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: true };
      },
    };
    await app.request(
      `/c/${CODE}`,
      { headers: { 'cf-connecting-ip': '203.0.113.7' } },
      testEnv({ RATE_LIMIT_PUBLIC: spy }),
    );
    expect(keys).toEqual(['203.0.113.7']);
  });

  it('la página no muestra ids ni nada fuera del alias y el estado', async () => {
    const { homeId, deviceId } = await seedHome({
      status: 'sin_luz',
      since: VET(18, 5),
      openOutageStart: VET(18, 5),
    });
    await sql`
      INSERT INTO app.follows (home_id, follower_device_id, alias, created_at)
      VALUES (${homeId}, ${deviceId}, 'Alias del seguidor', 0)`;
    const { html } = await get(`/c/${CODE}`);
    expect(html).not.toContain(homeId);
    expect(html).not.toContain(deviceId);
    expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(html).not.toContain('Alias del seguidor');
    expect(html).not.toContain('ExponentPushToken');
    expect(html).not.toMatch(/\d{13}/); // ningún epoch
    expect(html).not.toContain('<script');
    expect(html).not.toContain('src="http');
    // el código solo aparece en el enlace a esta misma página
    expect(html.match(new RegExp(CODE, 'g'))).toHaveLength(1);
  });

  it('el alias de la casa se escapa', async () => {
    await seedHome({ status: 'con_luz', since: VET(14, 30), alias: '<b>"Casa" & Cía</b>' });
    const { html } = await get(`/c/${CODE}`);
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
  });

  it('la página no aparece en el contrato OpenAPI', async () => {
    const { html } = await get('/openapi.json');
    const doc = JSON.parse(html) as { paths: Record<string, unknown> };
    expect(
      Object.keys(doc.paths).filter((p) => p.startsWith('/c/') || p.includes('.well-known')),
    ).toEqual([]);
  });

  describe('assetlinks.json', () => {
    it('da 404 sin huella y el JSON exacto con huella', async () => {
      for (const empty of [undefined, '', '  ']) {
        const { res, html } = await get(
          '/.well-known/assetlinks.json',
          testEnv({ ANDROID_CERT_SHA256: empty }),
        );
        expect(res.status).toBe(404);
        expect(JSON.parse(html)).toMatchObject({ error: { code: 'not_found' } });
      }

      const { res, html } = await get(
        '/.well-known/assetlinks.json',
        testEnv({ ANDROID_CERT_SHA256: FINGERPRINT }),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(JSON.parse(html)).toEqual([
        {
          relation: ['delegate_permission/common.handle_all_urls'],
          target: {
            namespace: 'android_app',
            package_name: 'com.isaacmendoza.pulso',
            sha256_cert_fingerprints: [FINGERPRINT],
          },
        },
      ]);
      expect(queries).toBe(0);
    });

    it('acepta varias huellas separadas por coma', async () => {
      const other = FINGERPRINT.replace(/^14/, 'AA');
      const { html } = await get(
        '/.well-known/assetlinks.json',
        testEnv({ ANDROID_CERT_SHA256: `${FINGERPRINT}, ${other}` }),
      );
      const [entry] = JSON.parse(html) as Array<{
        target: { sha256_cert_fingerprints: string[] };
      }>;
      expect(entry?.target.sha256_cert_fingerprints).toEqual([FINGERPRINT, other]);
    });
  });
});
