import { OpenAPIHono } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';
import type { ExecutionContext } from 'hono';
import openApiDocument from '../openapi.json';
import type { AppEnv, Bindings } from './env';
import { scheduled } from './jobs/scheduled';
import { withOptionalSentry } from './lib/sentry';
import { withDb } from './middleware/db';
import { apiError, errorHandler, notFoundHandler, validationHook } from './middleware/errors';
import { devices } from './modules/devices';
import { events } from './modules/events';
import { follows } from './modules/follows';
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
  /** El `fetch` para Expo Push (por defecto el global). Los tests pasan uno falso: jamás la red. */
  fetch?: typeof fetch;
};

export function createApp(options: CreateAppOptions = {}): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
  app.onError(errorHandler);
  app.notFound(notFoundHandler);
  const now = options.now ?? Date.now;
  // sin `this`: el `fetch` global de Workers lanza "Illegal invocation" como método de otro objeto
  const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  app.use('*', async (c, next) => {
    c.set('now', now);
    c.set('fetch', fetchImpl);
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
  app.route('/', follows);
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

const app = createApp();

// Sentry solo se activa en las invocaciones cuyo `env` trae `SENTRY_DSN` (A-039, B6).
export default withOptionalSentry({
  fetch: (request: Request, env: Bindings, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  scheduled,
});
