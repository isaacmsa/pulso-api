import type postgres from 'postgres';
import * as repo from './repo';
import { MAX_FOLLOWS } from './routes';

export type { FollowItem } from './repo';

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
