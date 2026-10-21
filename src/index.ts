import { OpenAPIHono } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';
import type { AppEnv } from './env';
import { withDb } from './middleware/db';
import { apiError, errorHandler, notFoundHandler, validationHook } from './middleware/errors';
import { devices } from './modules/devices';
import { events } from './modules/events';
import { health } from './modules/health';
import { homes } from './modules/homes';
import { buildOpenApiDocument } from './openapi';

export type CreateAppOptions = {
  /** Se llama por cada consulta a la base. Los tests lo usan para contar el presupuesto. */
  onQuery?: () => void;
  /** La hora del Worker en epoch ms (por defecto `Date.now`). La usan la auth y todas las rutas; los tests la fijan. */
  now?: () => number;
};

export function createApp(options: CreateAppOptions = {}): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
  app.onError(errorHandler);
  app.notFound(notFoundHandler);
  const now = options.now ?? Date.now;
  app.use('*', async (c, next) => {
    c.set('now', now);
    await next();
  });
  app.use('*', withDb(options.onQuery));
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearer', {
    type: 'http',
    scheme: 'bearer',
    description: 'Token del dispositivo, el que devuelve `POST /v1/devices`.',
  });
  app.route('/', health);
  app.route('/', devices);
  app.route('/', homes);
  app.route('/', events);
  // Ninguna de las dos toca la base. `/docs` solo se expone donde EXPOSE_DOCS es 'true' (staging).
  app.get('/openapi.json', (c) => c.json(buildOpenApiDocument(app)));
  app.get(
    '/docs',
    (c, next) =>
      c.env.EXPOSE_DOCS === 'true' ? next() : apiError(c, 404, 'not_found', 'No existe esa ruta.'),
    Scalar({ url: '/openapi.json' }),
  );
  return app;
}

export default createApp();
