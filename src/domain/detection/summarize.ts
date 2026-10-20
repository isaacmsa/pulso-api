import { caracasDate, startOfCaracasDay } from '../time/caracas';
import type { OutageStatus } from './types';

const DAY_MS = 86_400_000;

export type OutageSummary = { totalMs: number; days: { date: string; ms: number }[] };

// Suma solo cortes cerrados y abiertos (estos hasta now), recortados a [from, to).
// Reparte el tiempo por día local de Caracas y lista todos los días del rango, también los que suman 0.
export function summarizeOutages(
  outages: readonly { start: number; end: number | null; status: OutageStatus }[],
  range: { from: number; to: number; now: number },
): OutageSummary {
  const counted = outages.filter((o) => o.status === 'cerrado' || o.status === 'abierto');
  const days: { date: string; ms: number }[] = [];
  let totalMs = 0;

  for (let dayStart = startOfCaracasDay(range.from); dayStart < range.to; dayStart += DAY_MS) {
    const dayEnd = dayStart + DAY_MS;
    let ms = 0;
    for (const o of counted) {
      const start = Math.max(o.start, range.from, dayStart);
      const end = Math.min(o.end ?? range.now, range.to, dayEnd);
      if (end > start) ms += end - start;
    }
    days.push({ date: caracasDate(dayStart), ms });
    totalMs += ms;
  }

  return { totalMs, days };
}
