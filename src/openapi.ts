import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from './env';

/** Datos del documento OpenAPI 3.1 que consume la app (`openapi.json` y `GET /openapi.json`). */
export const OPENAPI_CONFIG = {
  openapi: '3.1.0',
  info: { title: 'Pulso API', version: '1.0.0' },
} as const;

export function buildOpenApiDocument(app: OpenAPIHono<AppEnv>) {
  return app.getOpenAPI31Document(OPENAPI_CONFIG);
}
