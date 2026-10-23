import { OpenAPIHono } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';
import openApiDocument from '../openapi.json';
import type { AppEnv } from './env';
import { withDb } from './middleware/db';
import { apiError, errorHandler, notFoundHandler, validationHook } from './middleware/errors';
import { devices } from './modules/devices';
import { events } from './modules/events';
import { health } from './modules/health';
import { homes } from './modules/homes';
import { outages } from './modules/outages';
import { pages } from './modules/pages';
import { serializeOpenApi } from './openapi';

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
  app.route('/', outages);
  app.route('/', events);
  app.route('/', pages);
  // Ninguna de las dos toca la base. `/docs` solo se expone donde EXPOSE_DOCS es 'true' (staging).
  // `/openapi.json` sirve el `openapi.json` del repo tal cual (sin construirlo en el Worker, que
  // gastaría CPU en cada isolate nuevo): `pnpm openapi:check` y el CI garantizan que coincide con
  // las rutas, y `deploy.yml` compara lo servido con el archivo. Se serializa una vez por isolate.
  let openApiText: string | undefined;
  app.get('/openapi.json', (c) => {
    openApiText ??= serializeOpenApi(openApiDocument);
    return c.body(openApiText, 200, { 'content-type': 'application/json' });
  });
  app.get(
    '/docs',
    (c, next) =>
      c.env.EXPOSE_DOCS === 'true' ? next() : apiError(c, 404, 'not_found', 'No existe esa ruta.'),
    Scalar({ url: '/openapi.json' }),
  );
  return app;
}

export default createApp();
