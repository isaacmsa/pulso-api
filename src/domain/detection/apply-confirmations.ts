import type { ConfirmationEvent, DeviceEvent } from '../events/schema';
import { CONFIRMATION_TOLERANCE_MS } from './constants';
import type { DetectedOutage } from './types';

const byTimeThenId = (a: ConfirmationEvent, b: ConfirmationEvent): number =>
  a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// El corte más cercano a outageStart dentro de la tolerancia; en empate, el más temprano.
const matchOutage = (
  outages: readonly DetectedOutage[],
  outageStart: number,
): DetectedOutage | undefined => {
  let best: DetectedOutage | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const o of outages) {
    const distance = Math.abs(outageStart - o.start);
    if (distance > CONFIRMATION_TOLERANCE_MS) continue;
    if (distance < bestDistance || (distance === bestDistance && o.start < (best?.start ?? 0))) {
      best = o;
      bestDistance = distance;
    }
  }
  return best;
};

export function applyConfirmations(
  outages: readonly DetectedOutage[],
  events: readonly DeviceEvent[],
): DetectedOutage[] {
  const result = new Map<DetectedOutage, DetectedOutage>();
  const confirmations = events
    .filter((e): e is ConfirmationEvent => e.kind === 'confirmation')
    .sort(byTimeThenId);

  // En orden cronológico, así la última de cada corte es la que queda.
  for (const c of confirmations) {
    const outage = matchOutage(outages, c.outageStart);
    if (!outage) continue;
    result.set(
      outage,
      c.answer
        ? { ...outage, confirmed: true }
        : { ...outage, status: 'descartado', confirmed: false },
    );
  }
  return outages.map((o) => result.get(o) ?? { ...o });
}
