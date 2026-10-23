import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../env';
import { apiError, validationHook } from '../../middleware/errors';
import { followHomeRoute, listFollowsRoute, MAX_FOLLOWS, unfollowHomeRoute } from './routes';
import * as service from './service';

export const follows = new OpenAPIHono<AppEnv>({ defaultHook: validationHook })
  .openapi(followHomeRoute, async (c) => {
    const result = await service.followHome(
      c.var.sql,
      c.var.device.id,
      c.req.valid('json'),
      c.var.now(),
    );
    switch (result.kind) {
      case 'not_found':
        return apiError(c, 404, 'not_found', 'No existe una casa con ese código.');
      case 'limit_reached':
        return apiError(c, 400, 'validation_failed', `Ya sigues ${MAX_FOLLOWS} casas.`);
      case 'followed':
        return c.json(result.item, 201);
    }
  })
  .openapi(listFollowsRoute, async (c) => {
    const items = await service.listFollows(c.var.sql, c.var.device.id);
    return c.json({ items }, 200);
  })
  .openapi(unfollowHomeRoute, async (c) => {
    await service.unfollowHome(c.var.sql, c.var.device.id, c.req.valid('param').homeId);
    return c.body(null, 204);
  });
