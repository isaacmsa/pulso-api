import { describe, expect, it } from 'vitest';
import { shiftExport, shiftUuidV7, uuidV7Time } from './shift-export';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Datos inventados: nada sale de un exporte real.
const BASE = Date.UTC(2030, 0, 1, 12, 0); // 1 de enero de 2030
const MIN = 60_000;

/** Un uuid v7 sintético con hora `time` y bits aleatorios inventados a partir de `n`. */
function v7(time: number, n: number): string {
  const hex = time.toString(16).padStart(12, '0');
  const tail = n.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7abc-9def-${tail}`;
}

describe('mover un exporte en el tiempo', () => {
  const id = v7(BASE, 1);

  it('lee la hora de un uuid v7', () => {
    expect(uuidV7Time(id)).toBe(BASE);
  });

  it('mueve la hora del uuid v7 y deja intactos la versión, la variante y lo aleatorio', () => {
    const shifted = shiftUuidV7(id, 123_456_789);
    expect(shifted).toMatch(UUID_V7);
    expect(uuidV7Time(shifted)).toBe(BASE + 123_456_789);
    expect(shifted.slice(14)).toBe(id.slice(14)); // desde la versión en adelante
  });

  it('acepta desfases negativos y conserva el orden de los ids', () => {
    const ids = [v7(BASE, 3), v7(BASE + 2_000, 1), v7(BASE + 9 * MIN, 2)];
    const shifted = ids.map((x) => shiftUuidV7(x, -86_400_000));
    expect(shifted.map(uuidV7Time)).toEqual(ids.map((x) => uuidV7Time(x) - 86_400_000));
    expect([...shifted].sort()).toEqual(shifted);
  });

  it('rechaza un uuid que no es v7 o una hora fuera de 48 bits', () => {
    expect(() => shiftUuidV7(id.replace('-7abc-', '-4abc-'), 1)).toThrow();
    expect(() => shiftUuidV7(id, -BASE - 1)).toThrow();
  });

  it('pone el primer evento en la hora pedida y mueve exportedAt, at, id y outageStart con el mismo desfase', () => {
    const data = {
      exportedAt: BASE + 30 * MIN,
      diagnostics: { model: 'X', sdkInt: 35 },
      events: [
        { kind: 'snapshot', id: v7(BASE, 1), at: BASE, plugged: true },
        { kind: 'report', id: v7(BASE + 5 * MIN, 2), at: BASE + 5 * MIN, value: 'sin_luz' },
        {
          kind: 'confirmation',
          id: v7(BASE + 20 * MIN, 3),
          at: BASE + 20 * MIN,
          outageStart: BASE + 5 * MIN,
          answer: true,
        },
      ],
    };
    const target = Date.UTC(2026, 10, 2, 14, 0);
    const { offset, shifted } = shiftExport(data, target);

    expect(offset).toBe(target - BASE);
    expect(shifted.exportedAt).toBe(BASE + 30 * MIN + offset);
    expect(shifted.diagnostics).toEqual({ model: 'X', sdkInt: 35 });
    expect(shifted.events[0]).toEqual({
      kind: 'snapshot',
      id: shiftUuidV7(v7(BASE, 1), offset),
      at: target,
      plugged: true,
    });
    expect(shifted.events[1]?.at).toBe(BASE + 5 * MIN + offset);
    expect(shifted.events[2]).toEqual({
      kind: 'confirmation',
      id: shiftUuidV7(v7(BASE + 20 * MIN, 3), offset),
      at: BASE + 20 * MIN + offset,
      outageStart: BASE + 5 * MIN + offset,
      answer: true,
    });
    for (const event of shifted.events) expect(uuidV7Time(event.id)).toBe(event.at);
  });

  it('falla si una hora queda sin mover dentro del rango del original', () => {
    const data = {
      exportedAt: BASE + 30 * MIN,
      // un campo de hora que el script no conoce: quedaría con la fecha real
      diagnostics: { model: 'X', lastBootAt: BASE + 2 * MIN },
      events: [
        { kind: 'snapshot', id: v7(BASE, 1), at: BASE },
        { kind: 'snapshot', id: v7(BASE + 10 * MIN, 2), at: BASE + 10 * MIN },
      ],
    };
    expect(() => shiftExport(data, Date.UTC(2026, 10, 2, 14, 0))).toThrow(/lastBootAt/);
  });
});
