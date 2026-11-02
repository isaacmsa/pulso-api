import {
  type Breadcrumb,
  type CloudflareOptions,
  type Event,
  withSentry,
} from '@sentry/cloudflare';
import type { Bindings } from '../env';

// Sentry del backend (A-039). Solo se activa si existe el secreto `SENTRY_DSN`. Todo lo que sale
// pasa por `scrubEvent` y `scrubBreadcrumb`: la regla 7 (los tokens nunca salen de la base ni de
// la respuesta de registro) también vale para Sentry, y los códigos de `/c/:code` son una
// capacidad (quien tiene el código ve el estado de la casa). Son funciones puras, sin red.

const MAX_DEPTH = 12;

/** El token del dispositivo: `<aleatorio>.<firma>`, 43 + 43 caracteres base64url (o más, por si algo lo rodea). */
const TOKEN_PATTERN = /[A-Za-z0-9_-]{43,}\.[A-Za-z0-9_-]{43,}/g;
/** `ExponentPushToken[...]` y `ExpoPushToken[...]`, el token de Expo Push de un teléfono. */
const PUSH_TOKEN_PATTERN = /Expo(?:nent)?PushToken\[[^\]]+\]/g;
/** `/c/<código>`: el código de la página de la familia. El alfabeto (`crypto.ts`) cabe en esta clase. */
const SHARE_CODE_PATH_PATTERN = /\/c\/[A-Za-z0-9_-]+/g;

/** Claves que nunca salen, en cualquier nivel y sin importar mayúsculas: credenciales y cuerpos. */
const DROPPED_KEYS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'cookies',
  'body',
  'request_body',
  'response_body',
]);

/** Claves de un breadcrumb o de la petición con una URL: se les quita la query y el fragmento. */
const URL_KEYS = ['url', 'from', 'to'] as const;

type Dict = Record<string, unknown>;

const isDict = (value: unknown): value is Dict =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function scrubString(text: string): string {
  return text
    .replace(TOKEN_PATTERN, '[token]')
    .replace(PUSH_TOKEN_PATTERN, '[push-token]')
    .replace(SHARE_CODE_PATH_PATTERN, '/c/[code]');
}

const withoutQuery = (url: string) => url.split(/[?#]/, 1)[0] ?? url;

/**
 * Copia `value` limpiando cada string (también las claves) y sin las claves de `DROPPED_KEYS`. Con
 * un tope de profundidad: lo que lo pasa (o un ciclo) se reemplaza por `[truncated]` en vez de
 * dejar pasar algo sin revisar.
 */
function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  const copy: Dict = {};
  for (const [key, inner] of Object.entries(value)) {
    if (DROPPED_KEYS.has(key.toLowerCase())) continue;
    copy[scrubString(key)] = scrubValue(inner, depth + 1);
  }
  return copy;
}

function stripUrls(record: Dict): void {
  for (const key of URL_KEYS) {
    const url = record[key];
    if (typeof url === 'string') record[key] = withoutQuery(url);
  }
}

/** `beforeBreadcrumb`: sin credenciales, cuerpos, tokens, códigos ni query strings. */
export function scrubBreadcrumb<T extends Breadcrumb>(crumb: T): T {
  const copy = scrubValue(crumb, 0) as Dict;
  if (isDict(copy.data)) stripUrls(copy.data);
  return copy as T;
}

/**
 * `beforeSend`: sin credenciales, cuerpos, cookies, usuario, query string ni datos de la petición;
 * `[token]`, `[push-token]` y `/c/[code]` en cualquier string del evento. No toca el original.
 */
export function scrubEvent<T extends Event>(event: T): T {
  const copy = scrubValue(event, 0) as Dict;
  delete copy.user;
  // El SDK toma la zona horaria de `request.cf`: es una ubicación aproximada, y Pulso no la guarda.
  if (isDict(copy.contexts)) delete copy.contexts.culture;
  if (isDict(copy.request)) {
    delete copy.request.data;
    delete copy.request.query_string;
    stripUrls(copy.request);
  }
  if (Array.isArray(copy.breadcrumbs)) {
    copy.breadcrumbs = copy.breadcrumbs.map((crumb: Breadcrumb) => scrubBreadcrumb(crumb));
  }
  return copy as T;
}

/** Sentry está activo solo con un `SENTRY_DSN` que no esté vacío. */
export function sentryEnabled(env: Pick<Bindings, 'SENTRY_DSN'>): boolean {
  return typeof env.SENTRY_DSN === 'string' && env.SENTRY_DSN.trim() !== '';
}

/**
 * Las opciones del SDK. La versión 11 ya no tiene `sendDefaultPii`: `dataCollection` lo reemplaza,
 * y aquí todo va apagado (usuario, cookies, encabezados, cuerpos y query strings). Sin trazas.
 * `release` lo toma el SDK de `SENTRY_RELEASE` o del binding `CF_VERSION_METADATA`, si existen.
 */
export function sentryOptions(env: Bindings): CloudflareOptions {
  return {
    dsn: env.SENTRY_DSN,
    environment: env.ENVIRONMENT,
    tracesSampleRate: 0,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
    },
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  };
}

/** El handler del Worker: lo que Cloudflare llama (`fetch` y `scheduled`). */
export type WorkerHandler = {
  fetch(request: Request, env: Bindings, ctx: never): Response | Promise<Response>;
  scheduled(controller: never, env: Bindings, ctx: never): void | Promise<void>;
};

type Wrap<H> = (optionsCallback: (env: Bindings) => CloudflareOptions, handler: H) => H;

/**
 * Envuelve el handler con `withSentry` **solo en las invocaciones cuyo `env` trae `SENTRY_DSN`**;
 * sin él, el handler corre tal cual, sin proxies del `env`, sin SDK y sin tocar el contexto
 * asíncrono. El envoltorio se crea la primera vez que hace falta, porque `withSentry` cambia el
 * estado global del runtime. Cubre `fetch` y `scheduled` (los errores del cron: retención y
 * `sweep`). Los errores que Hono atrapa en `app.onError` los reporta `errorHandler`.
 *
 * `wrap` y `options` son para los tests (un transporte de mentira): jamás la red.
 */
export function withOptionalSentry<H extends WorkerHandler>(
  handler: H,
  { wrap, options }: { wrap?: Wrap<H>; options?: CloudflareOptions } = {},
): H {
  const doWrap = wrap ?? (withSentry as unknown as Wrap<H>);
  let monitored: H | undefined;
  const pick = (env: Bindings): H => {
    if (!sentryEnabled(env)) return handler;
    // `withSentry` instrumenta el objeto que recibe: va una copia con funciones propias
    monitored ??= doWrap((e) => ({ ...sentryOptions(e), ...options }), {
      fetch: (request, e, ctx) => handler.fetch(request, e, ctx),
      scheduled: (controller, e, ctx) => handler.scheduled(controller, e, ctx),
    } as H);
    return monitored;
  };
  return {
    fetch: (request, env, ctx) => pick(env).fetch(request, env, ctx),
    scheduled: (controller, env, ctx) => pick(env).scheduled(controller, env, ctx),
  } as H;
}
