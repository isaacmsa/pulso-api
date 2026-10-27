import { formatClock, formatDuration, formatRange, shownDurationMs } from '../time/format';

/**
 * Los textos de push (docs/api.md, "Cuándo sale cada push"), en español venezolano llano y con
 * la hora de Caracas. La duración sale de las horas que se muestran (sin segundos), para que
 * "de 6:05 a 8:15" siempre diga "2 h 10 min".
 */
export type PushText = { title: 'Pulso'; body: string };

const text = (body: string): PushText => ({ title: 'Pulso', body });

/** Inicio, a los seguidores: "Se fue la luz en Casa de mamá (6:05 p. m.)". */
export function startMessage(alias: string, start: number): PushText {
  return text(`Se fue la luz en ${alias} (${formatClock(start)})`);
}

/** Regreso, si hubo push de inicio: "Volvió la luz en Casa de mamá tras 2 h 10 min". */
export function returnMessage(alias: string, start: number, end: number): PushText {
  return text(`Volvió la luz en ${alias} tras ${formatDuration(shownDurationMs(start, end))}`);
}

/** Resumen tardío, sin push de inicio: "En Casa de mamá se fue la luz de 6:05 a 8:15 p. m. (2 h 10 min)". */
export function lateSummaryMessage(alias: string, start: number, end: number): PushText {
  const duration = formatDuration(shownDurationMs(start, end));
  return text(`En ${alias} se fue la luz de ${formatRange(start, end)} (${duration})`);
}

/** Un corte con push de inicio que terminó descartado (A-034): "Volvió la luz en Casa de mamá". */
export function returnWithoutDurationMessage(alias: string): PushText {
  return text(`Volvió la luz en ${alias}`);
}

/** Confirmación, al teléfono de la casa: "¿Se fue la luz de 6:05 a 8:15 p. m.?". */
export function confirmationMessage(start: number, end: number): PushText {
  return text(`¿Se fue la luz de ${formatRange(start, end)}?`);
}
