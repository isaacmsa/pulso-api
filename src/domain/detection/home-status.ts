import type { HomeStatus } from '../homes/schema';
import type { DetectedOutage } from './types';

type StatusPair = { state: HomeStatus['state']; since: number };

/**
 * Estado de la casa tras clasificar un lote.
 * Con un corte abierto: `sin_luz` desde su `start` (si hay varios, el de `start` más tardío).
 * Sin corte abierto y `con_luz` antes: no cambia. Si no, `con_luz` desde el `end` más
 * tardío que sea `>= previous.since`, o desde `now` si no hay ninguno.
 */
export function deriveHomeStatus(
  previous: StatusPair,
  detected: readonly DetectedOutage[],
  now: number,
): StatusPair {
  const open = detected
    .filter((outage) => outage.status === 'abierto')
    .reduce<DetectedOutage | null>(
      (latest, outage) => (latest === null || outage.start > latest.start ? outage : latest),
      null,
    );
  if (open) return { state: 'sin_luz', since: open.start };

  if (previous.state === 'con_luz') return previous;

  const ends = detected
    .map((outage) => outage.end)
    .filter((end): end is number => end !== null && end >= previous.since);
  return { state: 'con_luz', since: ends.length > 0 ? Math.max(...ends) : now };
}
