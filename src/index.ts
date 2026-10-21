import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from './env';
import { withDb } from './middleware/db';
import { errorHandler, notFoundHandler, validationHook } from './middleware/errors';
import { health } from './modules/health';

export type CreateAppOptions = {
  /** Se llama por cada consulta a la base. Los tests lo usan para contar el presupuesto. */
  onQuery?: () => void;
};

export function createApp(options: CreateAppOptions = {}): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
  app.onError(errorHandler);
  app.notFound(notFoundHandler);
  app.use('*', withDb(options.onQuery));
  app.route('/', health);
  return app;
}

export default createApp();
