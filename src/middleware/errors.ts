import { z } from '@hono/zod-openapi';
import { captureException } from '@sentry/cloudflare';
import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '../env';
import { bearerToken } from './bearer';

export const errorCodeSchema = z.enum([
  'validation_failed',
  'invalid_token',
  'not_found',
  'home_exists',
  'rate_limited',
  'internal_error',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorSchema = z
  .object({
    error: z.object({
      code: errorCodeSchema,
      message: z.string(),
      issues: z.array(z.unknown()).optional(),
    }),
  })
  .openapi('Error');

/** Una respuesta de error de la API en la definición de una ruta. */
export const jsonError = (description: string) => ({
  description,
  content: { 'application/json': { schema: errorSchema } },
});

/** El 429 lleva `Retry-After` (lo ponen el limitador y el handler de errores). */
export const rateLimitedError = (description: string) => ({
  ...jsonError(description),
  headers: {
    'Retry-After': {
      description: 'Segundos que hay que esperar antes de reintentar',
      schema: { type: 'string' as const, example: '60' },
    },
  },
});

/** El 500 que puede devolver cualquier ruta si algo falla de nuestro lado. */
export const internalError = jsonError('`internal_error`: algo falló de nuestro lado');

/** Respuesta de error con la forma `{ error: { code, message } }` (docs/api.md). */
export function apiError<S extends ContentfulStatusCode, C extends ErrorCode>(
  c: Context,
  status: S,
  code: C,
  message: string,
  extra: { issues?: unknown[] } = {},
) {
  return c.json({ error: { code, message, ...extra } }, status);
}

function validationFailed(c: Context, issues: unknown[]) {
  return apiError(c, 400, 'validation_failed', 'La petición no es válida.', { issues });
}

/** `defaultHook` de OpenAPIHono: un esquema que no valida responde 400 con los issues de Zod. */
export function validationHook(
  result: { success: true } | { success: false; error: { issues: unknown[] } },
  c: Context<AppEnv>,
) {
  if (!result.success) return validationFailed(c, result.error.issues);
}

export const notFoundHandler: NotFoundHandler<AppEnv> = (c) =>
  apiError(c, 404, 'not_found', 'No existe esa ruta.');

/** Código y mensaje de una `HTTPException` según su estado (4xx sin código propio: validación). */
function fromHttpStatus(status: number): { code: ErrorCode; message: string } {
  switch (status) {
    case 401:
      return { code: 'invalid_token', message: 'El token falta o no es válido.' };
    case 404:
      return { code: 'not_found', message: 'No existe ese recurso.' };
    case 429:
      return { code: 'rate_limited', message: 'Demasiadas peticiones. Intenta de nuevo.' };
    default:
      return status < 500
        ? { code: 'validation_failed', message: 'La petición no es válida.' }
        : { code: 'internal_error', message: 'Algo falló de nuestro lado. Intenta de nuevo.' };
  }
}

/**
 * Una `HTTPException` responde con su estado en la forma de la API. Todo error no previsto, y las
 * `HTTPException` 5xx, responden 500 con un mensaje genérico. Al log va el nombre y la pila,
 * nunca las cabeceras ni el cuerpo, y el token se tapa por si un mensaje lo incluyera (regla 7).
 * Esos 500 también van a Sentry si está activo; un 4xx no es un error nuestro y no va.
 */
export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof HTTPException && err.status < 500) {
    // un JSON mal formado: Hono lanza HTTPException 400 antes de validar
    if (err.status === 400) return validationFailed(c, []);
    const { code, message } = fromHttpStatus(err.status);
    if (err.status === 429) c.header('Retry-After', '60'); // igual que el limitador
    return apiError(c, err.status, code, message);
  }

  // solo un Authorization bien formado es un token: uno corto taparía letras sueltas del log
  const token = bearerToken(c.req.header('authorization'));
  const redact = (text: string) => (token ? text.replaceAll(token, '[token]') : text);
  const code = (err as { code?: unknown }).code; // p. ej. el SQLSTATE de un PostgresError
  console.error('internal_error', {
    name: err.name,
    ...(typeof code === 'string' ? { code } : {}),
    stack: redact(err.stack ?? err.name),
  });
  // Sin cliente de Sentry (sin `SENTRY_DSN`) no hace nada. Hono atrapa el error aquí, así que el
  // envoltorio de `withSentry` no lo ve; `beforeSend` limpia tokens y encabezados (A-039).
  captureException(err, { mechanism: { handled: true, type: 'auto.http.hono.error_handler' } });
  const status = err instanceof HTTPException ? err.status : 500;
  return apiError(c, status, 'internal_error', fromHttpStatus(500).message);
};
