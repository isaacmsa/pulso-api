import { RECONCILE_TOLERANCE_MS } from './constants';
import type { DetectedOutage } from './types';

export type StoredOutage = DetectedOutage & { id: string };

export type OutageChange =
  | { op: 'insert'; outage: DetectedOutage }
  | { op: 'update'; id: string; outage: DetectedOutage };

const isSame = (a: DetectedOutage, b: DetectedOutage): boolean =>
  a.start === b.start &&
  a.end === b.end &&
  a.status === b.status &&
  a.confidence === b.confidence &&
  a.confirmed === b.confirmed;

/**
 * Convierte lo que clasificó `classify` en cambios sobre los cortes guardados.
 * Empareja uno a uno, en orden de `start`, cada detectado con el guardado libre más
 * cercano dentro de `RECONCILE_TOLERANCE_MS` (en empate, el de `start` más temprano).
 * El `id` de los inserts lo pone el servicio: el dominio no genera ids.
 */
export function reconcileOutages(
  stored: readonly StoredOutage[],
  detected: readonly DetectedOutage[],
): OutageChange[] {
  const free = [...stored].sort((a, b) => a.start - b.start);
  const changes: OutageChange[] = [];

  for (const outage of [...detected].sort((a, b) => a.start - b.start)) {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    free.forEach((candidate, index) => {
      const distance = Math.abs(candidate.start - outage.start);
      if (distance <= RECONCILE_TOLERANCE_MS && distance < bestDistance) {
        bestIndex = index;
        bestDistance = distance;
      }
    });

    if (bestIndex === -1) {
      changes.push({ op: 'insert', outage });
      continue;
    }
    const [match] = free.splice(bestIndex, 1);
    if (match && !isSame(match, outage)) {
      changes.push({ op: 'update', id: match.id, outage });
    }
  }

  for (const orphan of free) {
    if (orphan.status === 'descartado') continue;
    const { id, ...outage } = orphan;
    changes.push({ op: 'update', id, outage: { ...outage, status: 'descartado' } });
  }
  return changes;
}
