import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Mueve un exporte del registrador en el tiempo para poder publicarlo en test/fixtures/ sin la
// fecha real (el repo es público). Un solo desfase para exportedAt, cada at, cada outageStart y la
// hora de cada uuid v7: el orden y las distancias entre eventos quedan iguales.

const UUID_V7 = /^([0-9a-f]{8})-([0-9a-f]{4})-(7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const MAX_48_BITS = 2 ** 48 - 1;

// 2 de noviembre de 2026, 10:00 a. m. en Caracas (UTC−4)
export const DEFAULT_FIRST_AT = Date.UTC(2026, 10, 2, 14, 0);

function parseUuidV7(id: string): { time: number; rest: string } {
  const match = UUID_V7.exec(id);
  if (!match) throw new Error(`No es un uuid v7: ${id}`);
  const [, high = '', low = '', rest = ''] = match;
  return { time: Number.parseInt(high + low, 16), rest };
}

/** Los 48 bits de hora (epoch ms) de un uuid v7. */
export function uuidV7Time(id: string): number {
  return parseUuidV7(id).time;
}

/** El mismo uuid v7 con su hora movida `offsetMs`: versión, variante y bits aleatorios intactos. */
export function shiftUuidV7(id: string, offsetMs: number): string {
  const { time, rest } = parseUuidV7(id);
  const shifted = time + offsetMs;
  if (!Number.isSafeInteger(shifted) || shifted < 0 || shifted > MAX_48_BITS) {
    throw new Error(`La hora movida de ${id} no cabe en 48 bits`);
  }
  const hex = shifted.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8)}-${rest}`;
}

type ExportEvent = { id: string; at: number } & Record<string, unknown>;
type Export<E extends ExportEvent> = { exportedAt: number; events: E[] } & Record<string, unknown>;

/** Cualquier número mayor que esto es una hora en epoch ms (1e12 es septiembre de 2001). */
const EPOCH_MS_FLOOR = 1e12;

/** Cada número con pinta de hora (epoch ms) dentro de `value`, con su ruta. */
function epochFields(value: unknown, path = '$'): { path: string; value: number }[] {
  if (typeof value === 'number') return value > EPOCH_MS_FLOOR ? [{ path, value }] : [];
  if (Array.isArray(value)) return value.flatMap((item, i) => epochFields(item, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => epochFields(item, `${path}.${key}`));
  }
  return [];
}

/**
 * Mueve todo el exporte para que su primer evento quede en `firstAt`: `exportedAt`, el `at` y la
 * hora del uuid v7 de cada evento, y el `outageStart` de las confirmaciones. Falla si en la salida
 * queda alguna hora dentro del rango de horas del original: sería un campo que no se movió.
 */
export function shiftExport<E extends ExportEvent, X extends Export<E>>(
  data: X,
  firstAt: number,
): { offset: number; shifted: X } {
  if (data.events.length === 0) throw new Error('El exporte no tiene eventos');
  const offset = firstAt - Math.min(...data.events.map((event) => event.at));
  const shifted: X = {
    ...data,
    exportedAt: data.exportedAt + offset,
    events: data.events.map((event) => ({
      ...event,
      id: shiftUuidV7(event.id, offset),
      at: event.at + offset,
      ...(typeof event.outageStart === 'number' ? { outageStart: event.outageStart + offset } : {}),
    })),
  };

  const original = epochFields(data).map(({ value }) => value);
  const min = Math.min(...original);
  const max = Math.max(...original);
  const leaked = epochFields(shifted).filter(({ value }) => value >= min && value <= max);
  if (leaked.length > 0) {
    throw new Error(
      `Quedaron horas sin mover: ${leaked.map(({ path }) => path).join(', ')}. ` +
        'Muévelas en shiftExport o elige un firstAt fuera del rango del original.',
    );
  }
  return { offset, shifted };
}

function main(): void {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('Uso: pnpm fixtures:shift <entrada.json> <salida.json>');
    process.exit(1);
  }
  const { offset, shifted } = shiftExport(
    JSON.parse(readFileSync(input, 'utf8')),
    DEFAULT_FIRST_AT,
  );
  writeFileSync(output, `${JSON.stringify(shifted, null, 2)}\n`);
  console.log(`${shifted.events.length} eventos movidos ${offset} ms → ${output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
