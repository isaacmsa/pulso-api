import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from './env';
import { withDb } from './middleware/db';
import { errorHandler, notFoundHandler, validationHook } from './middleware/errors';
import { devices } from './modules/devices';
import { health } from './modules/health';
import { homes } from './modules/homes';

export type CreateAppOptions = {
  /** Se llama por cada consulta a la base. Los tests lo usan para contar el presupuesto. */
  onQuery?: () => void;
};

export function createApp(options: CreateAppOptions = {}): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
  app.onError(errorHandler);
  app.notFound(notFoundHandler);
  app.use('*', withDb(options.onQuery));
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearer', {
    type: 'http',
    scheme: 'bearer',
    description: 'Token del dispositivo, el que devuelve `POST /v1/devices`.',
  });
  app.route('/', health);
  app.route('/', devices);
  app.route('/', homes);
  return app;
}

export default createApp();
