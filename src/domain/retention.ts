const DAY_MS = 86_400_000;

/**
 * Cuánto se guarda cada cosa. Tiene que coincidir con `/privacidad` y con `docs/data-model.md`.
 * `EVENTS_RETENTION_MS` también está escrito como `2592000000` en `drizzle/0004_staleness.sql`
 * (`mark_stale`): `src/domain/retention.test.ts` comprueba que siguen iguales.
 */
export const EVENTS_RETENTION_MS = 30 * DAY_MS;
export const INACTIVE_DEVICE_MS = 180 * DAY_MS;
export const UNUSED_REGISTRATION_MS = 7 * DAY_MS;
