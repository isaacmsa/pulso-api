import { z } from '@hono/zod-openapi';
import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '../env';

export type ErrorCode =
  | 'validation_failed'
  | 'invalid_token'
  | 'not_found'
  | 'home_exists'
  | 'rate_limited'
  | 'internal_error';

export const errorSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      issues: z.array(z.unknown()).optional(),
    }),
  })
  .openapi('Error');

/** Respuesta de error con la forma `{ error: { code, message } }` (docs/api.md). */
export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  code: ErrorCode,
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

/**
 * Todo error no previsto responde 500 con un mensaje genérico. Al log va el nombre y la pila,
 * nunca las cabeceras ni el cuerpo, y el token se tapa por si un mensaje lo incluyera (regla 7).
 */
export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  // un JSON mal formado: Hono lanza HTTPException 400 antes de validar
  if (err instanceof HTTPException && err.status === 400) return validationFailed(c, []);

  const token = /^Bearer +(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
  const redact = (text: string) => (token ? text.replaceAll(token, '[token]') : text);
  const code = (err as { code?: unknown }).code; // p. ej. el SQLSTATE de un PostgresError
  console.error('internal_error', {
    name: err.name,
    ...(typeof code === 'string' ? { code } : {}),
    stack: redact(err.stack ?? err.name),
  });
  return apiError(c, 500, 'internal_error', 'Algo falló de nuestro lado. Intenta de nuevo.');
};
