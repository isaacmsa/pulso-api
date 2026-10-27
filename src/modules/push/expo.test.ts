import { describe, expect, it } from 'vitest';
import { getReceipts, type PushMessage, sendPushes } from './expo';

const SEND_URL = 'https://exp.host/--/api/v2/push/send';
const RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';

type Call = { url: string; init: RequestInit; body: unknown };

/** Un `fetch` de mentira: guarda las llamadas y responde con lo que diga `respond`. */
function fakeFetch(respond: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      init: init ?? {},
      body: JSON.parse(String(init?.body ?? 'null')),
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function message(n: number): PushMessage {
  return {
    to: `ExponentPushToken[${n}]`,
    title: 'Pulso',
    body: `Mensaje ${n}`,
    data: { homeId: 'h' },
    channelId: 'cortes',
    deviceId: `device-${n}`,
  };
}

const messages = (count: number) => Array.from({ length: count }, (_, i) => message(i));

/** Responde ok a cada mensaje de un envío, con un ticket `t-<token>`. */
const allOk = (call: Call) =>
  json({
    data: (call.body as PushMessage[]).map((m) => ({ status: 'ok', id: `t-${m.to}` })),
  });

describe('sendPushes', () => {
  it('parte 250 mensajes en 3 envíos', async () => {
    const { impl, calls } = fakeFetch(allOk);
    const results = await sendPushes(messages(250), { fetch: impl });
    expect(calls.map((c) => (c.body as unknown[]).length)).toEqual([100, 100, 50]);
    expect(calls.every((c) => c.url === SEND_URL)).toBe(true);
    expect(results).toHaveLength(250);
    expect(results[249]).toEqual({ deviceId: 'device-249', ticketId: 't-ExponentPushToken[249]' });
  });

  it('manda el token de acceso solo si existe', async () => {
    const without = fakeFetch(allOk);
    await sendPushes(messages(1), { fetch: without.impl });
    const withoutHeaders = new Headers(without.calls[0]?.init.headers);
    expect(withoutHeaders.has('authorization')).toBe(false);
    expect(withoutHeaders.get('content-type')).toBe('application/json');
    expect(withoutHeaders.get('accept')).toBe('application/json');

    const withToken = fakeFetch(allOk);
    await sendPushes(messages(1), { fetch: withToken.impl, accessToken: 'secreto' });
    expect(new Headers(withToken.calls[0]?.init.headers).get('authorization')).toBe(
      'Bearer secreto',
    );
  });

  it('no manda el deviceId a Expo y conserva el resto del mensaje', async () => {
    const { impl, calls } = fakeFetch(allOk);
    await sendPushes([{ ...message(1), categoryId: 'confirm_outage' }], { fetch: impl });
    const sent = calls.at(0)?.body as Record<string, unknown>[];
    expect(sent[0]).toEqual({
      to: 'ExponentPushToken[1]',
      title: 'Pulso',
      body: 'Mensaje 1',
      data: { homeId: 'h' },
      channelId: 'cortes',
      categoryId: 'confirm_outage',
    });
  });

  it('no llama a Expo sin mensajes', async () => {
    const { impl, calls } = fakeFetch(allOk);
    expect(await sendPushes([], { fetch: impl })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('asigna cada error de ticket a su dispositivo', async () => {
    const { impl } = fakeFetch(() =>
      json({
        data: [
          { status: 'ok', id: 'a' },
          {
            status: 'error',
            message: 'no registrado',
            details: { error: 'DeviceNotRegistered' },
          },
          { status: 'error', message: 'algo falló' },
        ],
      }),
    );
    expect(await sendPushes(messages(3), { fetch: impl })).toEqual([
      { deviceId: 'device-0', ticketId: 'a' },
      { deviceId: 'device-1', error: 'DeviceNotRegistered' },
      { deviceId: 'device-2', error: 'algo falló' },
    ]);
  });

  it('un error de red de Expo no lanza: devuelve los errores por mensaje', async () => {
    const { impl } = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const results = await sendPushes(messages(150), { fetch: impl });
    expect(results).toHaveLength(150);
    expect(results.every((r) => r.error === 'network_error' && r.ticketId === undefined)).toBe(
      true,
    );
    expect(results.map((r) => r.deviceId)).toEqual(messages(150).map((m) => m.deviceId));
  });

  it('un error de todo el envío falla solo ese grupo, con el código de Expo', async () => {
    const { impl } = fakeFetch((call, index) =>
      index === 0
        ? json({ errors: [{ code: 'PUSH_TOO_MANY_EXPERIENCE_IDS', message: 'x' }] }, 400)
        : allOk(call),
    );
    const results = await sendPushes(messages(150), { fetch: impl });
    expect(results.slice(0, 100).every((r) => r.error === 'PUSH_TOO_MANY_EXPERIENCE_IDS')).toBe(
      true,
    );
    expect(results.slice(100).every((r) => r.ticketId !== undefined)).toBe(true);
  });

  it('una respuesta que no es JSON o con otro largo falla el grupo sin lanzar', async () => {
    const html = fakeFetch(() => new Response('<html>502</html>', { status: 502 }));
    const a = await sendPushes(messages(2), { fetch: html.impl });
    expect(a.map((r) => r.error)).toEqual(['http_502', 'http_502']);

    const short = fakeFetch(() => json({ data: [{ status: 'ok', id: 'a' }] }));
    const b = await sendPushes(messages(2), { fetch: short.impl });
    expect(b.map((r) => r.error)).toEqual(['bad_response', 'bad_response']);
  });
});

describe('getReceipts', () => {
  it('parte 1500 ids en 2 consultas y junta los recibos', async () => {
    const ids = Array.from({ length: 1500 }, (_, i) => `t-${i}`);
    const { impl, calls } = fakeFetch((call) => {
      const asked = (call.body as { ids: string[] }).ids;
      return json({
        data: Object.fromEntries(
          asked.map((id) =>
            id === 't-7'
              ? [id, { status: 'error', message: 'x', details: { error: 'DeviceNotRegistered' } }]
              : [id, { status: 'ok' }],
          ),
        ),
      });
    });
    const receipts = await getReceipts(ids, { fetch: impl, accessToken: 'secreto' });
    expect(calls.map((c) => (c.body as { ids: string[] }).ids.length)).toEqual([1000, 500]);
    expect(calls.every((c) => c.url === RECEIPTS_URL)).toBe(true);
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer secreto');
    expect(Object.keys(receipts)).toHaveLength(1500);
    expect(receipts['t-7']).toEqual({ status: 'error', error: 'DeviceNotRegistered' });
    expect(receipts['t-8']).toEqual({ status: 'ok' });
  });

  it('un grupo que falla devuelve sus ids marcados para reintentar, sin lanzar', async () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `t-${i}`);
    const { impl } = fakeFetch((call, index) => {
      if (index === 0) throw new TypeError('fetch failed');
      return json({
        data: Object.fromEntries(
          (call.body as { ids: string[] }).ids.map((id) => [id, { status: 'ok' }]),
        ),
      });
    });
    const receipts = await getReceipts(ids, { fetch: impl });
    expect(receipts['t-0']).toEqual({ status: 'error', error: 'network_error', retry: true });
    expect(receipts['t-999']?.retry).toBe(true);
    expect(receipts['t-1000']).toEqual({ status: 'ok' });
  });

  it('no llama a Expo sin ids', async () => {
    const { impl, calls } = fakeFetch(allOk);
    expect(await getReceipts([], { fetch: impl })).toEqual({});
    expect(calls).toHaveLength(0);
  });
});
