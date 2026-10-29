import { RECONCILE_TOLERANCE_MS } from './constants';
import type { DetectedOutage, OutageStatus } from './types';

/** Un corte guardado. Además de lo que detecta el clasificador, puede estar `sin_datos` (el cron `sweep`). */
export type StoredOutage = Omit<DetectedOutage, 'status'> & { id: string; status: OutageStatus };

export type ReconcileOptions = {
  /**
   * El `at` del primer evento de la ventana. Los guardados que empiezan antes quedan fuera: sus
   * eventos de inicio no están en la ventana (la retención los borró), así que el clasificador no
   * los puede volver a ver y nunca se reescriben (A-042).
   */
  windowStart?: number;
};

export type OutageChange =
  | { op: 'insert'; outage: DetectedOutage }
  | { op: 'update'; id: string; outage: DetectedOutage };

const isSame = (a: StoredOutage, b: DetectedOutage): boolean =>
  a.start === b.start &&
  a.end === b.end &&
  a.status === b.status &&
  a.confidence === b.confidence &&
  a.confirmed === b.confirmed;

/**
 * Convierte lo que clasificó `classify` en cambios sobre los cortes guardados.
 * Empareja uno a uno, en orden de `start`, cada detectado con el guardado libre más
 * cercano dentro de `RECONCILE_TOLERANCE_MS` (en empate, el de `start` más temprano).
 * Un guardado sin pareja queda `descartado`, salvo que ya lo esté o esté `sin_datos` (A-038: solo
 * los eventos atrasados que lo vuelven a detectar lo cambian). Los guardados que empiezan antes de
 * `windowStart` no se tocan (A-042). El `id` de los inserts lo pone el servicio: el dominio no
 * genera ids.
 */
export function reconcileOutages(
  stored: readonly StoredOutage[],
  detected: readonly DetectedOutage[],
  { windowStart }: ReconcileOptions = {},
): OutageChange[] {
  const free = stored
    .filter((outage) => windowStart === undefined || outage.start >= windowStart)
    .sort((a, b) => a.start - b.start);
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
    if (orphan.status === 'descartado' || orphan.status === 'sin_datos') continue;
    const { id, ...outage } = orphan;
    changes.push({ op: 'update', id, outage: { ...outage, status: 'descartado' } });
  }
  return changes;
}
