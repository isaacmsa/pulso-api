import { z } from '@hono/zod-openapi';
import { epochMs } from '../events/schema';

/** Alias de una casa, el mío o el que le pongo a la que sigo: 1 a 40 caracteres, recortado. */
export const aliasSchema = z.string().trim().min(1).max(40).openapi({ example: 'Casa de mamá' });

/** El alfabeto de `generateShareCode` (src/lib/crypto.ts): sin 0, 1, I, L ni O. */
const SHARE_CODE_PATTERN = /^[2-9A-HJKMNP-Z]{8}$/;

/** El código de una casa tal como lo devuelve la API: 8 caracteres en mayúsculas. */
export const shareCodeSchema = z.string().regex(SHARE_CODE_PATTERN);

/**
 * El código que manda la app al seguir una casa: se pasa a mayúsculas **antes** de validar, así
 * que las minúsculas se aceptan, y el OpenAPI declara el patrón con las dos.
 */
export const shareCodeInputSchema = z
  .preprocess((value) => (typeof value === 'string' ? value.toUpperCase() : value), shareCodeSchema)
  .openapi({
    type: 'string',
    pattern: '^[2-9A-HJKMNP-Za-hjkmnp-z]{8}$',
    description: 'Código de la casa, 8 caracteres. Las minúsculas se aceptan',
    example: 'K7M2QX9P',
  });

export const homeStatusSchema = z
  .object({
    state: z.enum(['con_luz', 'sin_luz', 'sin_noticias']),
    since: epochMs,
    alias: z.string(),
    openOutageStart: epochMs.nullable(),
  })
  .openapi('HomeStatus');
export type HomeStatus = z.infer<typeof homeStatusSchema>;
