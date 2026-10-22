import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../env';
import { apiError } from './errors';

const JSON_CONTENT_TYPE = /^application\/([a-z-.]+\+)?json/i;

/** Tope del cuerpo JSON. Un lote de 200 eventos ronda los 60 KB. */
export const MAX_JSON_BODY_BYTES = 256 * 1024;

/**
 * Sin `Content-Length` (cuerpo por partes), `bodyLimit` cuenta mientras lee y corta al pasar del
 * tope. Responde 413 con `validation_failed`: el enum de códigos no cambia (docs/api.md).
 */
const limitBody = bodyLimit({
  maxSize: MAX_JSON_BODY_BYTES,
  onError: (c) => apiError(c, 413, 'validation_failed', 'El cuerpo de la petición pasa de 256 KB.'),
});

/**
 * Las rutas con cuerpo lo exigen JSON y de 256 KB como máximo. Sin `Content-Type` JSON,
 * `@hono/zod-openapi` valida un `{}` inventado, y un esquema con defaults o sin campos
 * obligatorios lo aceptaría. El tope corre antes de leer el cuerpo con Zod (10 ms de CPU).
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
  return limitBody(c, next);
};
