import type postgres from 'postgres';
import * as repo from './repo';

export type { FollowItem } from './repo';

/** Tope de casas que sigue un dispositivo (A-036). */
export const MAX_FOLLOWS = 20;

export function followHome(
  sql: postgres.Sql,
  deviceId: string,
  input: { code: string; alias: string },
  now: number,
): Promise<repo.FollowResult> {
  return repo.followHome(sql, { ...input, deviceId, now, max: MAX_FOLLOWS });
}

export const listFollows = repo.listFollows;
export const unfollowHome = repo.deleteFollow;
