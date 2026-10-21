import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { apiError } from './errors';

const JSON_CONTENT_TYPE = /^application\/([a-z-.]+\+)?json/i;

/**
 * Las rutas con cuerpo lo exigen JSON. Sin `Content-Type` JSON, `@hono/zod-openapi` valida un
 * `{}` inventado, y un esquema con defaults o sin campos obligatorios lo aceptaría.
 */
export const requireJsonBody: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!JSON_CONTENT_TYPE.test(c.req.header('content-type') ?? '')) {
    return apiError(
      c,
      400,
      'validation_failed',
      'La petición no es válida: falta el cuerpo JSON.',
      {
        issues: [],
      },
    );
  }
  await next();
};
