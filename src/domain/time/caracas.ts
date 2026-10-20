// America/Caracas es UTC−4 fijo (sin horario de verano). Aritmética de epoch, sin Intl.
export const CARACAS_OFFSET_MS = -14_400_000;

const DAY_MS = 86_400_000;

// Fecha local de Caracas como YYYY-MM-DD.
export function caracasDate(ts: number): string {
  return new Date(ts + CARACAS_OFFSET_MS).toISOString().slice(0, 10);
}

// Medianoche local de Caracas del día que contiene ts, en epoch ms.
export function startOfCaracasDay(ts: number): number {
  const dayIndex = Math.floor((ts + CARACAS_OFFSET_MS) / DAY_MS);
  return dayIndex * DAY_MS - CARACAS_OFFSET_MS;
}

// Lunes a las 00:00 local de la semana que contiene ts. El día 0 (1970-01-01) fue jueves.
export function startOfCaracasWeek(ts: number): number {
  const dayIndex = Math.floor((ts + CARACAS_OFFSET_MS) / DAY_MS);
  const daysSinceMonday = (((dayIndex + 3) % 7) + 7) % 7;
  return (dayIndex - daysSinceMonday) * DAY_MS - CARACAS_OFFSET_MS;
}
