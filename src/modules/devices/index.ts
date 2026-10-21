import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../env';
import { validationHook } from '../../middleware/errors';
import { deleteDeviceRoute, patchDeviceRoute, registerRoute } from './routes';
import * as service from './service';

export const devices = new OpenAPIHono<AppEnv>({ defaultHook: validationHook })
  .openapi(registerRoute, async (c) => {
    const { appVersion } = c.req.valid('json');
    const registered = await service.registerDevice(
      c.var.db,
      appVersion,
      Date.now(),
      c.env.TOKEN_SIGNING_KEY,
    );
    return c.json(registered, 201);
  })
  .openapi(patchDeviceRoute, async (c) => {
    await service.updateDevice(c.var.db, c.var.device, c.req.valid('json'));
    return c.body(null, 204);
  })
  .openapi(deleteDeviceRoute, async (c) => {
    await service.deleteDevice(c.var.sql, c.var.device);
    return c.body(null, 204);
  });
