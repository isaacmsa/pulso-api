import type postgres from 'postgres';
import type { HomeStatus } from '../../domain/homes/schema';

export type FollowItem = { homeId: string; alias: string; status: HomeStatus };

type FollowRow = {
  home_id: string;
  follow_alias: string | null;
  home_alias: string;
  status: HomeStatus['state'];
  status_since: string; // bigint: postgres.js lo devuelve como texto
  open_outage_start: string | null;
};

function toItem(row: FollowRow & { follow_alias: string }): FollowItem {
  return {
    homeId: row.home_id,
    alias: row.follow_alias,
    status: {
      state: row.status,
      since: Number(row.status_since),
      alias: row.home_alias,
      openOutageStart: row.open_outage_start === null ? null : Number(row.open_outage_start),
    },
  };
}

export type FollowResult =
  | { kind: 'followed'; item: FollowItem }
  | { kind: 'not_found' }
  | { kind: 'limit_reached' };

/**
 * Sigue la casa con ese código, en **una sola consulta**: busca la casa, cuenta los follows del
 * dispositivo, hace el upsert (que solo corre bajo el tope, o si ya la seguía) y lee el estado y
 * el corte abierto. Sin fila: el código no existe. Con fila y sin `follow_alias`: no entró por el
 * tope. Con dos peticiones a la vez el tope puede pasarse por una (cada una cuenta antes de que
 * entre la otra); es un tope de cortesía, no de seguridad.
 */
export async function followHome(
  sql: postgres.Sql,
  follow: { code: string; deviceId: string; alias: string; now: number; max: number },
): Promise<FollowResult> {
  const [row] = await sql<FollowRow[]>`
    WITH target AS (
      SELECT id, alias, status, status_since FROM app.homes WHERE share_code = ${follow.code}
    ), mine AS (
      SELECT home_id FROM app.follows WHERE follower_device_id = ${follow.deviceId}::uuid
    ), upserted AS (
      INSERT INTO app.follows (home_id, follower_device_id, alias, created_at)
      SELECT t.id, ${follow.deviceId}::uuid, ${follow.alias}::text, ${follow.now}::bigint
      FROM target t
      WHERE (SELECT count(*) FROM mine) < ${follow.max}::int
         OR t.id IN (SELECT home_id FROM mine)
      ON CONFLICT (home_id, follower_device_id) DO UPDATE SET alias = EXCLUDED.alias
      RETURNING home_id, alias
    )
    SELECT t.id AS home_id, u.alias AS follow_alias, t.alias AS home_alias, t.status,
           t.status_since, open_outage.started_at AS open_outage_start
    FROM target t
    LEFT JOIN upserted u ON u.home_id = t.id
    LEFT JOIN LATERAL (
      SELECT o.started_at FROM app.outages o
      WHERE o.home_id = t.id AND o.status = 'abierto'
      ORDER BY o.started_at DESC
      LIMIT 1
    ) open_outage ON true`;
  if (!row) return { kind: 'not_found' };
  if (row.follow_alias === null) return { kind: 'limit_reached' };
  return { kind: 'followed', item: toItem({ ...row, follow_alias: row.follow_alias }) };
}

/** Las casas que sigue el dispositivo con su estado, por alias, en una sola consulta. */
export async function listFollows(sql: postgres.Sql, deviceId: string): Promise<FollowItem[]> {
  const rows = await sql<FollowRow[]>`
    SELECT f.home_id, f.alias AS follow_alias, h.alias AS home_alias, h.status, h.status_since,
           open_outage.started_at AS open_outage_start
    FROM app.follows f
    JOIN app.homes h ON h.id = f.home_id
    LEFT JOIN LATERAL (
      SELECT o.started_at FROM app.outages o
      WHERE o.home_id = f.home_id AND o.status = 'abierto'
      ORDER BY o.started_at DESC
      LIMIT 1
    ) open_outage ON true
    WHERE f.follower_device_id = ${deviceId}
    ORDER BY lower(f.alias), f.alias, f.home_id`;
  return rows.map((row) => toItem({ ...row, follow_alias: row.follow_alias as string }));
}

/** Borra solo el follow de este dispositivo: el `WHERE` lleva siempre el dispositivo. */
export async function deleteFollow(
  sql: postgres.Sql,
  deviceId: string,
  homeId: string,
): Promise<void> {
  await sql`
    DELETE FROM app.follows WHERE follower_device_id = ${deviceId} AND home_id = ${homeId}`;
}
