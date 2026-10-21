import { z } from '@hono/zod-openapi';
import { epochMs } from '../events/schema';

export const homeStatusSchema = z.object({
  state: z.enum(['con_luz', 'sin_luz', 'sin_noticias']),
  since: epochMs,
  alias: z.string(),
  openOutageStart: epochMs.nullable(),
});
export type HomeStatus = z.infer<typeof homeStatusSchema>;
