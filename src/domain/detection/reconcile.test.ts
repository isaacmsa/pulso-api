import { describe, expect, it } from 'vitest';
import { at } from '../../testing/builders';
import { reconcileOutages, type StoredOutage } from './reconcile';
import type { DetectedOutage, OutageStatus } from './types';

/** Un corte guardado, con cualquier estado (incluido `sin_datos`, que pone el cron `sweep`). */
const stored = (id: string, s: number, e: number | null, status: OutageStatus): StoredOutage => ({
  ...o(s, e),
  status,
  id,
});

const o = (
  s: number,
  e: number | null,
  status: DetectedOutage['status'] = e === null ? 'abierto' : 'cerrado',
): DetectedOutage => ({
  start: at(s),
  end: e === null ? null : at(e),
  status,
  confidence: 'alta',
  confirmed: null,
});

describe('reconcileOutages', () => {
  it('un corte nuevo se inserta', () =>
    expect(reconcileOutages([], [o(5, null)])).toEqual([{ op: 'insert', outage: o(5, null) }]));

  it('un corte igual no produce cambios', () =>
    expect(reconcileOutages([{ ...o(5, 125), id: 'a' }], [o(5, 125)])).toEqual([]));

  it('cerrar el corte abierto actualiza el mismo id', () =>
    expect(reconcileOutages([{ ...o(5, null), id: 'a' }], [o(5, 125)])).toEqual([
      { op: 'update', id: 'a', outage: o(5, 125) },
    ]));

  it('un inicio que se mueve dentro de la tolerancia actualiza el mismo corte', () =>
    expect(reconcileOutages([{ ...o(5, null), id: 'a' }], [o(2, null)])).toEqual([
      { op: 'update', id: 'a', outage: o(2, null) },
    ]));

  it('fuera de la tolerancia son cortes distintos', () =>
    expect(reconcileOutages([{ ...o(5, 125), id: 'a' }], [o(5, 125), o(200, null)])).toEqual([
      { op: 'insert', outage: o(200, null) },
    ]));

  it('un corte guardado que ya no aparece queda descartado', () =>
    expect(reconcileOutages([{ ...o(5, 125), id: 'a' }], [])).toEqual([
      { op: 'update', id: 'a', outage: o(5, 125, 'descartado') },
    ]));

  it('cada guardado se empareja una sola vez', () =>
    expect(reconcileOutages([{ ...o(5, 20), id: 'a' }], [o(4, 6, 'descartado'), o(7, 30)])).toEqual(
      [
        { op: 'update', id: 'a', outage: o(4, 6, 'descartado') },
        { op: 'insert', outage: o(7, 30) },
      ],
    ));

  it('un guardado ya descartado que no aparece no produce cambios', () =>
    expect(reconcileOutages([{ ...o(5, 125, 'descartado'), id: 'a' }], [])).toEqual([]));

  it('un cambio de confianza o de confirmación actualiza el corte', () =>
    expect(
      reconcileOutages([{ ...o(5, 125), id: 'a' }], [{ ...o(5, 125), confirmed: true }]),
    ).toEqual([{ op: 'update', id: 'a', outage: { ...o(5, 125), confirmed: true } }]));

  it('en empate de distancia gana el guardado más temprano', () =>
    expect(
      reconcileOutages(
        [
          { ...o(10, 40), id: 'b' },
          { ...o(0, 30), id: 'a' },
        ],
        [o(5, 35)],
      ),
    ).toEqual([
      { op: 'update', id: 'a', outage: o(5, 35) },
      { op: 'update', id: 'b', outage: o(10, 40, 'descartado') },
    ]));

  it('un sin_datos sin pareja no cambia', () =>
    expect(reconcileOutages([stored('a', 5, null, 'sin_datos')], [])).toEqual([]));

  it('un sin_datos emparejado se actualiza a lo detectado', () =>
    expect(reconcileOutages([stored('a', 5, null, 'sin_datos')], [o(5, 125)])).toEqual([
      { op: 'update', id: 'a', outage: o(5, 125) },
    ]));

  it('un sin_datos emparejado que sigue abierto vuelve a abierto', () =>
    expect(reconcileOutages([stored('a', 5, null, 'sin_datos')], [o(5, null)])).toEqual([
      { op: 'update', id: 'a', outage: o(5, null) },
    ]));

  it('un corte abierto cuyos eventos de inicio ya se purgaron no se reescribe', () =>
    // la ventana arranca en el minuto 100 porque la retención borró lo anterior (A-042)
    expect(
      reconcileOutages([stored('a', 5, null, 'abierto')], [], { windowStart: at(100) }),
    ).toEqual([]));

  it('un guardado anterior a la ventana tampoco se empareja', () =>
    expect(
      reconcileOutages([stored('a', 98, null, 'abierto')], [o(101, 130)], {
        windowStart: at(100),
      }),
    ).toEqual([{ op: 'insert', outage: o(101, 130) }]));

  it('un guardado que empieza justo en el inicio de la ventana sí se reconcilia', () =>
    expect(
      reconcileOutages([stored('a', 100, null, 'abierto')], [], { windowStart: at(100) }),
    ).toEqual([{ op: 'update', id: 'a', outage: o(100, null, 'descartado') }]));
});
