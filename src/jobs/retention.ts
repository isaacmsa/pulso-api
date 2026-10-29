import type postgres from 'postgres';

const DAY_MS = 86_400_000;

/** Cuánto se guarda cada cosa. Tiene que coincidir con `/privacidad` y con `docs/data-model.md`. */
export const EVENTS_RETENTION_MS = 30 * DAY_MS;
export const INACTIVE_DEVICE_MS = 180 * DAY_MS;
export const UNUSED_REGISTRATION_MS = 7 * DAY_MS;

export type RetentionResult = {
  /** `events` de más de 30 días. */
  events: number;
  /** Dispositivos de más de 180 días sin actividad. */
  inactiveDevices: number;
  /** Casas de esos dispositivos inactivos. */
  homes: number;
  /** Registros de más de 7 días que nunca mandaron nada, ni siguen una casa. */
  unusedDevices: number;
  /** Cortes `abierto` que empezaron hace más de 30 días y pasaron a `sin_datos` (A-042). */
  oldOutages: number;
};

/**
 * La retención diaria, en UNA consulta (regla 5). Tres `DELETE` y un `UPDATE` en CTE, que ven
 * todos la misma foto de la base:
 *
 * - `events` con `at` de más de 30 días.
 * - `devices` con `last_seen_at` de más de 180 días, **con su casa**: igual que
 *   `deleteDeviceAndHome`, porque `devices.home_id` no borra la casa y la política promete que
 *   los datos se guardan "hasta 180 días sin actividad". Los eventos, cortes y follows de esa casa
 *   y los follows, eventos y tickets del dispositivo se van por cascada, al final de la consulta.
 * - `devices` con más de 7 días que nunca mandaron nada: sin casa, sin follows y con
 *   `last_seen_at = created_at`.
 *
 * - Cortes `abierto` que empezaron hace más de 30 días pasan a `sin_datos` (A-042): sus eventos de
 *   inicio se borran en esta misma pasada, el clasificador ya no los puede ver y quedarían abiertos
 *   para siempre. No se tocan los de las casas que se borran aquí. No sube `ingest_revision`: el
 *   estado de la casa no cambia y ese corte ya queda fuera de toda reconciliación, así que un lote
 *   en vuelo no puede pisar nada; y bloquear la casa después del corte invertiría el orden de
 *   `mark_stale` (casa y luego cortes), que corre a la misma hora (8:00 UTC).
 *
 * Los dos criterios de `devices` salen de un solo `doomed`: un registro sin uso de más de 180 días
 * cumple los dos y se borra y se cuenta una vez (como inactivo). Un dispositivo del segundo grupo
 * no tiene casa, así que no hay riesgo de borrar la misma casa dos veces.
 */
export async function runRetention(sql: postgres.Sql, now: number): Promise<RetentionResult> {
  const eventsBefore = now - EVENTS_RETENTION_MS;
  const inactiveBefore = now - INACTIVE_DEVICE_MS;
  const unusedBefore = now - UNUSED_REGISTRATION_MS;

  const [row] = await sql<
    {
      events: number;
      inactive_devices: number;
      homes: number;
      unused_devices: number;
      old_outages: number;
    }[]
  >`
    WITH old_events AS (
      DELETE FROM app.events WHERE at < ${eventsBefore} RETURNING 1
    ),
    doomed AS (
      SELECT d.id, d.home_id, d.last_seen_at < ${inactiveBefore} AS inactive
      FROM app.devices d
      WHERE d.last_seen_at < ${inactiveBefore}
         OR (d.created_at < ${unusedBefore}
             AND d.home_id IS NULL
             AND d.last_seen_at = d.created_at
             AND NOT EXISTS (SELECT 1 FROM app.follows f WHERE f.follower_device_id = d.id))
    ),
    old_homes AS (
      DELETE FROM app.homes
      WHERE id IN (SELECT home_id FROM doomed WHERE home_id IS NOT NULL)
      RETURNING 1
    ),
    old_devices AS (
      DELETE FROM app.devices WHERE id IN (SELECT id FROM doomed) RETURNING id
    ),
    old_outages AS (
      UPDATE app.outages SET status = 'sin_datos', updated_at = ${now}
      WHERE status = 'abierto'
        AND started_at < ${eventsBefore}
        AND home_id NOT IN (SELECT home_id FROM doomed WHERE home_id IS NOT NULL)
      RETURNING 1
    )
    SELECT
      (SELECT count(*) FROM old_events)::int AS events,
      (SELECT count(*) FROM old_devices od JOIN doomed USING (id) WHERE doomed.inactive)::int
        AS inactive_devices,
      (SELECT count(*) FROM old_homes)::int AS homes,
      (SELECT count(*) FROM old_devices od JOIN doomed USING (id) WHERE NOT doomed.inactive)::int
        AS unused_devices,
      (SELECT count(*) FROM old_outages)::int AS old_outages`;
  if (!row) throw new Error('La retención no devolvió conteos');
  return {
    events: row.events,
    inactiveDevices: row.inactive_devices,
    homes: row.homes,
    unusedDevices: row.unused_devices,
    oldOutages: row.old_outages,
  };
}
