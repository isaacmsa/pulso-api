import { CARACAS_OFFSET_MS, caracasDate } from './caracas';

const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;

type Clock = { time: string; suffix: 'a. m.' | 'm.' | 'p. m.' };

/** La hora de Caracas partida en "6:05" y "p. m.". Los segundos se ignoran. */
function clockParts(ts: number): Clock {
  const minuteOfDay =
    ((Math.floor((ts + CARACAS_OFFSET_MS) / MINUTE_MS) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  const time = `${hours % 12 || 12}:${String(minutes).padStart(2, '0')}`;
  if (minuteOfDay === 12 * 60) return { time, suffix: 'm.' };
  return { time, suffix: hours < 12 ? 'a. m.' : 'p. m.' };
}

/** "6:05 p. m.", siempre en Caracas. El mediodía es "12:00 m." y la medianoche "12:00 a. m.". */
export function formatClock(ts: number): string {
  const { time, suffix } = clockParts(ts);
  return `${time} ${suffix}`;
}

/** "2 h 10 min", "45 min" o "1 h", redondeado al minuto más cercano. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / MINUTE_MS));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

/**
 * "6:05 a 8:15 p. m.": si las dos horas caen en la misma mitad del mismo día de Caracas, el
 * "a. m." o "p. m." va una sola vez; si no, "11:30 a. m. a 1:15 p. m.".
 */
export function formatRange(start: number, end: number): string {
  const from = clockParts(start);
  const to = clockParts(end);
  const sameHalf =
    from.suffix === to.suffix && from.suffix !== 'm.' && caracasDate(start) === caracasDate(end);
  return sameHalf
    ? `${from.time} a ${to.time} ${to.suffix}`
    : `${from.time} ${from.suffix} a ${to.time} ${to.suffix}`;
}

/** Minutos enteros entre dos horas tal como se muestran (sin segundos), en ms. */
export function shownDurationMs(start: number, end: number): number {
  return (Math.floor(end / MINUTE_MS) - Math.floor(start / MINUTE_MS)) * MINUTE_MS;
}
