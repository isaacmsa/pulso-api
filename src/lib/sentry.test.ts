import type { Breadcrumb, ErrorEvent } from '@sentry/cloudflare';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv, Bindings } from '../env';
import type { CronController } from '../jobs/scheduled';
import { errorHandler } from '../middleware/errors';
import { generateToken } from './crypto';
import {
  scrubBreadcrumb,
  scrubEvent,
  sentryEnabled,
  sentryOptions,
  withOptionalSentry,
} from './sentry';

const SIGNING_KEY = 'a'.repeat(43); // 32 bytes en base64url
const TOKEN = `${'A'.repeat(43)}.${'b'.repeat(43)}`;
const PUSH_TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';

const event = (fields: Record<string, unknown>) => fields as unknown as ErrorEvent;

describe('scrubEvent', () => {
  it('beforeSend borra Authorization y el cuerpo', () => {
    const scrubbed = scrubEvent(
      event({
        request: {
          url: 'https://pulso-api.example/v1/events',
          method: 'POST',
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            authorization: `Bearer ${TOKEN}`,
            COOKIE: 'a=b',
            'set-cookie': 'a=b',
            'content-type': 'application/json',
          },
          cookies: { a: 'b' },
          data: '{"events":[]}',
          query_string: 'code=ABCD2345',
        },
        extra: { body: '{"pushToken":"x"}', otro: 1 },
      }),
    );

    expect(scrubbed.request?.headers).toEqual({ 'content-type': 'application/json' });
    expect(scrubbed.request).not.toHaveProperty('data');
    expect(scrubbed.request).not.toHaveProperty('cookies');
    expect(scrubbed.request).not.toHaveProperty('query_string');
    expect(scrubbed.extra).toEqual({ otro: 1 });
    expect(JSON.stringify(scrubbed)).not.toContain(TOKEN);
  });

  it('quita la zona horaria que Cloudflare deja en contexts.culture', () => {
    const scrubbed = scrubEvent(
      event({ contexts: { culture: { timezone: 'America/Caracas' }, runtime: { name: 'x' } } }),
    );

    expect(scrubbed.contexts).not.toHaveProperty('culture');
    expect(scrubbed.contexts).toHaveProperty('runtime');
  });

  it('un token dentro de un mensaje queda como [token]', () => {
    const scrubbed = scrubEvent(
      event({
        message: `falló con ${TOKEN} y otra vez ${TOKEN}`,
        exception: { values: [{ type: 'Error', value: `Bearer ${TOKEN}` }] },
      }),
    );

    expect(scrubbed.message).toBe('falló con [token] y otra vez [token]');
    expect(scrubbed.exception?.values?.[0]?.value).toBe('Bearer [token]');
  });

  it('un push token de Expo queda como [push-token]', () => {
    const scrubbed = scrubEvent(
      event({
        message: `DeviceNotRegistered ${PUSH_TOKEN} y ExpoPushToken[abc-123]`,
        extra: { to: PUSH_TOKEN },
      }),
    );

    expect(scrubbed.message).toBe('DeviceNotRegistered [push-token] y [push-token]');
    expect(scrubbed.extra).toEqual({ to: '[push-token]' });
  });

  it('el código de /c/:code queda como [code] en la url, la ruta y el nombre de la transacción', () => {
    const scrubbed = scrubEvent(
      event({
        transaction: 'GET /c/ABCD2345',
        request: { url: 'https://pulso-api.example/c/ABCD2345?x=1#y' },
        breadcrumbs: [{ message: 'GET /c/ABCD2345' }],
      }),
    );

    expect(scrubbed.transaction).toBe('GET /c/[code]');
    expect(scrubbed.request?.url).toBe('https://pulso-api.example/c/[code]');
    expect(scrubbed.breadcrumbs?.[0]?.message).toBe('GET /c/[code]');
  });

  it('limpia valores anidados en arreglos, objetos y contexts, sea cual sea la profundidad', () => {
    const scrubbed = scrubEvent(
      event({
        extra: { a: { b: [{ c: { d: `x ${TOKEN}` } }, [PUSH_TOKEN]] } },
        contexts: { custom: { headers: { Authorization: TOKEN, ok: 'si' }, note: TOKEN } },
        breadcrumbs: [{ data: { url: 'https://x.test/p?token=1', note: TOKEN } }],
        tags: { who: TOKEN },
      }),
    );

    expect(scrubbed.extra).toEqual({ a: { b: [{ c: { d: 'x [token]' } }, ['[push-token]']] } });
    expect(scrubbed.contexts).toEqual({ custom: { headers: { ok: 'si' }, note: '[token]' } });
    expect(scrubbed.breadcrumbs?.[0]?.data?.note).toBe('[token]');
    expect(scrubbed.tags).toEqual({ who: '[token]' });
  });

  it('un objeto demasiado profundo o cíclico no revienta ni deja pasar un token', () => {
    const cyclic: Record<string, unknown> = { token: `t ${TOKEN}` };
    cyclic.self = cyclic;
    let deep: Record<string, unknown> = { leaf: TOKEN };
    for (let i = 0; i < 100; i++) deep = { next: deep };

    const scrubbed = scrubEvent(event({ extra: { cyclic, deep } }));

    expect(JSON.stringify(scrubbed)).not.toContain(TOKEN);
  });

  it('no toca el evento original y deja intacto lo que no es sensible', () => {
    const original = event({
      message: `x ${TOKEN}`,
      level: 'error',
      exception: {
        values: [{ type: 'Error', stacktrace: { frames: [{ lineno: 3, in_app: true }] } }],
      },
    });

    const scrubbed = scrubEvent(original);

    expect(original.message).toContain(TOKEN);
    expect(scrubbed.level).toBe('error');
    expect(scrubbed.exception?.values?.[0]?.stacktrace?.frames?.[0]).toEqual({
      lineno: 3,
      in_app: true,
    });
  });

  it('borra el usuario', () => {
    const scrubbed = scrubEvent(event({ user: { ip_address: '1.2.3.4', id: 'x' } }));
    expect(scrubbed).not.toHaveProperty('user');
  });
});

describe('scrubBreadcrumb', () => {
  it('limpia el mensaje, los datos y los encabezados de un breadcrumb', () => {
    const crumb: Breadcrumb = {
      category: 'fetch',
      message: `GET /c/ABCD2345 con ${TOKEN}`,
      data: {
        url: 'https://exp.host/push/send?x=1',
        request_headers: { authorization: `Bearer ${TOKEN}` },
        body: PUSH_TOKEN,
        to: PUSH_TOKEN,
      },
    };

    const scrubbed = scrubBreadcrumb(crumb);

    expect(scrubbed).toEqual({
      category: 'fetch',
      message: 'GET /c/[code] con [token]',
      data: { url: 'https://exp.host/push/send', request_headers: {}, to: '[push-token]' },
    });
  });
});

describe('opciones de Sentry', () => {
  const env = { ENVIRONMENT: 'staging', SENTRY_DSN: 'https://k@o0.ingest.sentry.io/1' } as Bindings;

  it('no manda datos personales ni trazas', () => {
    const options = sentryOptions(env);

    expect(options).toMatchObject({
      dsn: env.SENTRY_DSN,
      environment: 'staging',
      tracesSampleRate: 0,
      beforeSend: scrubEvent,
      beforeBreadcrumb: scrubBreadcrumb,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
      },
    });
  });

  it('solo está activo con un SENTRY_DSN que no esté vacío', () => {
    expect(sentryEnabled(env)).toBe(true);
    expect(sentryEnabled({ ...env, SENTRY_DSN: undefined })).toBe(false);
    expect(sentryEnabled({ ...env, SENTRY_DSN: '' })).toBe(false);
    expect(sentryEnabled({ ...env, SENTRY_DSN: '   ' })).toBe(false);
  });
});

describe('withOptionalSentry', () => {
  const baseEnv = { ENVIRONMENT: 'test', TOKEN_SIGNING_KEY: SIGNING_KEY } as Bindings;

  function handler() {
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.get('/ok', (c) => c.text('ok'));
    app.get('/boom', () => {
      throw new Error(`falló con ${TOKEN} y ${PUSH_TOKEN}`);
    });
    app.post('/boom', async (c) => {
      await c.req.text();
      throw new Error('falló al guardar');
    });
    return {
      fetch: (request: Request, env: Bindings, ctx: { waitUntil(p: Promise<unknown>): void }) =>
        app.fetch(request, env, ctx as never),
      scheduled: vi.fn(async (_controller: CronController, _env: Bindings, _ctx: unknown) => {
        throw new Error(`el sweep falló con ${PUSH_TOKEN}`);
      }),
    };
  }

  /** Un ExecutionContext de mentira que guarda lo que va a esperar el Worker. */
  function context() {
    const pending: Promise<unknown>[] = [];
    return {
      ctx: {
        waitUntil: (p: Promise<unknown>) => void pending.push(p),
        passThroughOnException() {},
      },
      settle: async () => {
        await Promise.allSettled(pending);
      },
    };
  }

  /** Un transporte de Sentry de mentira: guarda cada evento que saldría. */
  function fakeTransport() {
    const events: Record<string, unknown>[] = [];
    const transport = () => ({
      send: async (envelope: unknown) => {
        const [, items] = envelope as [unknown, [{ type: string }, Record<string, unknown>][]];
        for (const [header, payload] of items) if (header.type === 'event') events.push(payload);
        return { statusCode: 200 };
      },
      flush: async () => true,
    });
    return { events, transport };
  }

  it('sin SENTRY_DSN la app no inicializa Sentry', async () => {
    const wrap = vi.fn();
    const base = handler();
    const worker = withOptionalSentry(base, { wrap });
    const { ctx, settle } = context();

    const res = await worker.fetch(new Request('https://x.test/ok'), baseEnv, ctx);
    await expect(
      worker.scheduled({ cron: '*/5 * * * *', scheduledTime: 0 }, baseEnv, ctx),
    ).rejects.toThrow('el sweep falló');
    await settle();

    expect(await res.text()).toBe('ok');
    expect(wrap).not.toHaveBeenCalled();
    expect(base.scheduled).toHaveBeenCalledTimes(1);
  });

  it('con un DSN vacío tampoco', async () => {
    const wrap = vi.fn();
    const worker = withOptionalSentry(handler(), { wrap });
    const { ctx } = context();

    await worker.fetch(new Request('https://x.test/ok'), { ...baseEnv, SENTRY_DSN: '' }, ctx);

    expect(wrap).not.toHaveBeenCalled();
  });

  it('un 500 que llega a Sentry no lleva el token, el push token ni el encabezado', async () => {
    const { events, transport } = fakeTransport();
    const token = await generateToken(SIGNING_KEY);
    const env = { ...baseEnv, SENTRY_DSN: 'https://k@o0.ingest.sentry.io/1' };
    const worker = withOptionalSentry(handler(), { options: { transport, cacheClient: false } });
    const { ctx, settle } = context();

    const res = await worker.fetch(
      new Request('https://x.test/boom?code=ABCD2345', {
        headers: { authorization: `Bearer ${token}`, cookie: 'a=b' },
      }),
      env,
      ctx,
    );
    await settle();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: 'internal_error', message: 'Algo falló de nuestro lado. Intenta de nuevo.' },
    });
    expect(events.length).toBeGreaterThan(0);
    const sent = JSON.stringify(events);
    expect(sent).not.toContain(token);
    expect(sent).not.toContain(TOKEN);
    expect(sent).not.toContain('xxxxxxxxxxxxxxxxxxxxxx');
    expect(sent).not.toContain('ABCD2345');
    expect(sent.toLowerCase()).not.toContain('authorization');
    expect(sent).toContain('[token]');
    expect(sent).toContain('[push-token]');
    expect(events[0]).toMatchObject({ environment: 'test' });
  });

  it('el cuerpo de la petición no sale en el evento', async () => {
    const { events, transport } = fakeTransport();
    const env = { ...baseEnv, SENTRY_DSN: 'https://k@o0.ingest.sentry.io/1' };
    const worker = withOptionalSentry(handler(), { options: { transport, cacheClient: false } });
    const { ctx, settle } = context();

    const res = await worker.fetch(
      new Request('https://x.test/boom', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secreto: 'cuerpo-privado' }),
      }),
      env,
      ctx,
    );
    await settle();

    expect(res.status).toBe(500);
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain('cuerpo-privado');
  });

  it('un error del cron (sweep, retención) también llega a Sentry, limpio', async () => {
    const { events, transport } = fakeTransport();
    const env = { ...baseEnv, SENTRY_DSN: 'https://k@o0.ingest.sentry.io/1' };
    const worker = withOptionalSentry(handler(), { options: { transport, cacheClient: false } });
    const { ctx, settle } = context();

    await expect(
      worker.scheduled({ cron: '*/5 * * * *', scheduledTime: 1_800_000_000_000 }, env, ctx),
    ).rejects.toThrow('el sweep falló');
    await settle();

    expect(events.length).toBeGreaterThan(0);
    const sent = JSON.stringify(events);
    expect(sent).toContain('el sweep falló con [push-token]');
    expect(sent).not.toContain('xxxxxxxxxxxxxxxxxxxxxx');
  });

  it('un 404 o un 401 no es un error de Sentry', async () => {
    const { events, transport } = fakeTransport();
    const env = { ...baseEnv, SENTRY_DSN: 'https://k@o0.ingest.sentry.io/1' };
    const worker = withOptionalSentry(handler(), { options: { transport, cacheClient: false } });
    const { ctx, settle } = context();

    const res = await worker.fetch(new Request('https://x.test/no-existe'), env, ctx);
    await settle();

    expect(res.status).toBe(404);
    expect(events).toEqual([]);
  });
});
