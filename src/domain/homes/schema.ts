import { z } from '@hono/zod-openapi';
import { epochMs } from '../events/schema';

/** Alias de una casa, el mío o el que le pongo a la que sigo: 1 a 40 caracteres, recortado. */
export const aliasSchema = z.string().trim().min(1).max(40).openapi({ example: 'Casa de mamá' });

export const homeStatusSchema = z
  .object({
    state: z.enum(['con_luz', 'sin_luz', 'sin_noticias']),
    since: epochMs,
    alias: z.string(),
    openOutageStart: epochMs.nullable(),
  })
  .openapi('HomeStatus');
export type HomeStatus = z.infer<typeof homeStatusSchema>;
