import { describe, expect, it } from 'vitest';
import { at } from '../../testing/builders';
import { reconcileOutages } from './reconcile';
import type { DetectedOutage } from './types';

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
});
