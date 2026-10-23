import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../env';
import { apiError, validationHook } from '../../middleware/errors';
import {
  createHomeRoute,
  homeStatusRoute,
  patchHomeRoute,
  regenerateShareCodeRoute,
} from './routes';
import * as service from './service';

const NO_HOME = 'Este dispositivo no vigila ninguna casa.';
const HOME_EXISTS = 'Este dispositivo ya vigila una casa.';

export const homes = new OpenAPIHono<AppEnv>({ defaultHook: validationHook })
  .openapi(createHomeRoute, async (c) => {
    const device = c.var.device;
    if (device.homeId) return apiError(c, 409, 'home_exists', HOME_EXISTS);
    const { alias } = c.req.valid('json');
    const created = await service.createHomeForDevice(c.var.sql, device, alias, c.var.now());
    // null: otra petición del mismo dispositivo le asignó la casa entre la auth y el INSERT
    if (!created) return apiError(c, 409, 'home_exists', HOME_EXISTS);
    return c.json(created, 201);
  })
  .openapi(patchHomeRoute, async (c) => {
    const { homeId } = c.var.device;
    if (!homeId) return apiError(c, 404, 'not_found', NO_HOME);
    const updated = await service.updateHome(c.var.db, homeId, c.req.valid('json'));
    if (!updated) return apiError(c, 404, 'not_found', NO_HOME);
    return c.body(null, 204);
  })
  .openapi(homeStatusRoute, (c) => {
    const status = service.homeStatus(c.var.device);
    if (!status) return apiError(c, 404, 'not_found', NO_HOME);
    return c.json(status, 200);
  })
  .openapi(regenerateShareCodeRoute, async (c) => {
    const { homeId } = c.var.device;
    if (!homeId) return apiError(c, 404, 'not_found', NO_HOME);
    const shareCode = await service.regenerateShareCode(c.var.sql, homeId);
    if (!shareCode) return apiError(c, 404, 'not_found', NO_HOME);
    return c.json({ shareCode }, 200);
  });
