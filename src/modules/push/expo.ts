/**
 * Cliente de Expo Push (https://docs.expo.dev/push-notifications/sending-notifications/).
 *
 * Envía en grupos de 100 y lee recibos en grupos de 1000. Nunca lanza por un error de red o de
 * HTTP: cada mensaje (o cada id) devuelve su error, para que quien llama decida. `fetch` siempre
 * se inyecta (en los tests, uno de mentira: jamás se llama a la red).
 *
 * Un ticket solo dice que Expo aceptó el mensaje. El resultado real (p. ej. `DeviceNotRegistered`)
 * llega después en el recibo, unos 15 min más tarde; por eso `repo.ts` guarda los tickets.
 */

const SEND_URL = 'https://exp.host/--/api/v2/push/send';
const RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const SEND_CHUNK = 100;
const RECEIPTS_CHUNK = 1000;

export type PushMessage = {
  to: string;
  title?: string;
  body: string;
  data?: Record<string, unknown>;
  channelId: 'cortes';
  categoryId?: 'confirm_outage';
  /** Solo para devolver el resultado a su dispositivo: no se manda a Expo. */
  deviceId: string;
};

/** `to` es el token al que se mandó: sirve para borrarlo solo si el dispositivo no lo cambió. */
export type SendResult = { deviceId: string; to: string; ticketId?: string; error?: string };

export type Receipt = {
  status: 'ok' | 'error';
  error?: string;
  /** Solo en un recibo que no se pudo leer (falló la llamada): hay que volver a intentarlo. */
  retry?: true;
};

export type ExpoOptions = { fetch: typeof fetch; accessToken?: string };

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;

/**
 * El código de un ticket o recibo con error: `details.error` (p. ej. `DeviceNotRegistered`), y si
 * no viene, `error`. Nunca el `message` de Expo: es texto libre y puede citar el token (regla 7),
 * y estos códigos van a los logs.
 */
function errorCode(item: Record<string, unknown>): string {
  const details = item.details;
  return isObject(details) && typeof details.error === 'string' ? details.error : 'error';
}

function headers(accessToken: string | undefined): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate',
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type Reply = { ok: true; body: unknown } | { ok: false; error: string };

/**
 * Una llamada a Expo. Un fallo (red, HTTP no 2xx, cuerpo ilegible) vuelve como `{ ok: false }` con
 * un código: el de Expo si vino en `errors[0].code`, y si no `network_error`, `http_<status>` o
 * `bad_response`.
 */
async function post(url: string, payload: unknown, opts: ExpoOptions): Promise<Reply> {
  let res: Response;
  try {
    // Se saca de `opts` para llamarla sin `this`: el `fetch` global de Workers lanza "Illegal
    // invocation" si se invoca como método de otro objeto.
    const doFetch = opts.fetch;
    res = await doFetch(url, {
      method: 'POST',
      headers: headers(opts.accessToken),
      body: JSON.stringify(payload),
    });
  } catch {
    return { ok: false, error: 'network_error' };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: res.ok ? 'bad_response' : `http_${res.status}` };
  }
  if (!res.ok) {
    const code = (body as { errors?: { code?: unknown }[] } | null)?.errors?.[0]?.code;
    return { ok: false, error: typeof code === 'string' ? code : `http_${res.status}` };
  }
  return { ok: true, body };
}

export async function sendPushes(
  messages: readonly PushMessage[],
  opts: ExpoOptions,
): Promise<SendResult[]> {
  const results: SendResult[] = [];
  for (const group of chunks(messages, SEND_CHUNK)) {
    const payload = group.map(({ deviceId: _deviceId, ...message }) => message);
    const reply = await post(SEND_URL, payload, opts);
    const tickets = reply.ok ? (reply.body as { data?: unknown } | null)?.data : undefined;
    if (!reply.ok || !Array.isArray(tickets) || tickets.length !== group.length) {
      const error = reply.ok ? 'bad_response' : reply.error;
      for (const m of group) results.push({ deviceId: m.deviceId, to: m.to, error });
      continue;
    }
    group.forEach((m, i) => {
      const ticket: unknown = tickets[i];
      const base = { deviceId: m.deviceId, to: m.to };
      if (!isObject(ticket)) {
        results.push({ ...base, error: 'bad_response' });
      } else if (ticket.status === 'ok') {
        results.push(
          typeof ticket.id === 'string'
            ? { ...base, ticketId: ticket.id }
            : { ...base, error: 'bad_response' },
        );
      } else if (ticket.status === 'error') {
        results.push({ ...base, error: errorCode(ticket) });
      } else {
        results.push({ ...base, error: 'bad_response' });
      }
    });
  }
  return results;
}

export async function getReceipts(
  ids: readonly string[],
  opts: ExpoOptions,
): Promise<Record<string, Receipt>> {
  const receipts: Record<string, Receipt> = {};
  for (const group of chunks(ids, RECEIPTS_CHUNK)) {
    const reply = await post(RECEIPTS_URL, { ids: group }, opts);
    const data = reply.ok ? (reply.body as { data?: unknown } | null)?.data : undefined;
    if (!reply.ok || !isObject(data) || Array.isArray(data)) {
      const error = reply.ok ? 'bad_response' : reply.error;
      for (const id of group) receipts[id] = { status: 'error', error, retry: true };
      continue;
    }
    // Un id que no viene en la respuesta no tiene recibo todavía (o Expo ya lo olvidó): se omite.
    // Un recibo que no se entiende se marca para reintentar, no se descarta.
    for (const [id, raw] of Object.entries(data)) {
      if (isObject(raw) && raw.status === 'ok') {
        receipts[id] = { status: 'ok' };
      } else if (isObject(raw) && raw.status === 'error') {
        receipts[id] = { status: 'error', error: errorCode(raw) };
      } else {
        receipts[id] = { status: 'error', error: 'bad_response', retry: true };
      }
    }
  }
  return receipts;
}
