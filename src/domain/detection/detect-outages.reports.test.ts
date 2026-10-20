import { describe, expect, it } from 'vitest';
import { at, report, snap } from '../../testing/builders';
import { detectOutages } from './detect-outages';

const base = (events: Parameters<typeof detectOutages>[0]) =>
  detectOutages(events, { mode: 'base' });

describe('reportes manuales', () => {
  it('sin_luz sin corte abierto abre uno manual', () => {
    expect(base([snap(0, true, true), report(10, 'sin_luz')])).toEqual([
      { start: at(10), end: null, status: 'abierto', confidence: 'manual', confirmed: null },
    ]);
  });
  it('hay_luz cierra el corte abierto', () => {
    expect(base([snap(0, true, true), snap(5, false, false), report(50, 'hay_luz')])).toEqual([
      { start: at(5), end: at(50), status: 'cerrado', confidence: 'alta', confirmed: null },
    ]);
  });
  it('fluctuando no crea cortes', () => {
    expect(base([snap(0, true, true), report(3, 'fluctuando'), snap(4, true, true)])).toEqual([]);
  });
  it('un snapshot repetido no cierra un corte manual', () => {
    expect(base([snap(0, true, true), report(10, 'sin_luz'), snap(25, true, true)])).toEqual([
      { start: at(10), end: null, status: 'abierto', confidence: 'manual', confirmed: null },
    ]);
  });
  it('el corte manual se cierra al entrar en powered', () => {
    expect(base([snap(0, false, false), report(10, 'sin_luz'), snap(60, true, true)])).toEqual([
      { start: at(10), end: at(60), status: 'cerrado', confidence: 'manual', confirmed: null },
    ]);
  });
  it('sin_luz con un corte abierto no cambia nada', () => {
    expect(
      base([
        snap(0, true, true),
        snap(5, false, false),
        report(7, 'sin_luz'),
        snap(65, true, true),
      ]),
    ).toEqual([
      { start: at(5), end: at(65), status: 'cerrado', confidence: 'alta', confirmed: null },
    ]);
  });
  it('hay_luz antes de 10 min deja el corte manual descartado', () => {
    expect(base([snap(0, true, true), report(10, 'sin_luz'), report(15, 'hay_luz')])).toEqual([
      { start: at(10), end: at(15), status: 'descartado', confidence: 'manual', confirmed: null },
    ]);
  });
  it('entrar en powered antes de 10 min deja el corte manual descartado', () => {
    expect(base([snap(0, false, false), report(10, 'sin_luz'), snap(15, true, true)])).toEqual([
      { start: at(10), end: at(15), status: 'descartado', confidence: 'manual', confirmed: null },
    ]);
  });
  it('hay_luz rearma desde el último snapshot', () => {
    // Con luz en el último snapshot: queda armado y la siguiente caída abre sin otro snapshot
    expect(
      base([
        snap(0, true, true),
        report(10, 'sin_luz'),
        report(60, 'hay_luz'),
        snap(70, false, false),
      ]),
    ).toEqual([
      { start: at(10), end: at(60), status: 'cerrado', confidence: 'manual', confirmed: null },
      { start: at(70), end: null, status: 'abierto', confidence: 'alta', confirmed: null },
    ]);
    // Sin luz en el último snapshot: no queda armado y la misma caída no abre
    expect(
      base([
        snap(0, false, false),
        report(10, 'sin_luz'),
        report(60, 'hay_luz'),
        snap(70, false, false),
      ]),
    ).toEqual([
      { start: at(10), end: at(60), status: 'cerrado', confidence: 'manual', confirmed: null },
    ]);
  });
  it('en modo UPS, sin_luz abre un corte manual y hay_luz lo cierra', () => {
    expect(
      detectOutages([snap(0, true, true), report(10, 'sin_luz'), report(60, 'hay_luz')], {
        mode: 'ups',
      }),
    ).toEqual([
      { start: at(10), end: at(60), status: 'cerrado', confidence: 'manual', confirmed: null },
    ]);
  });
  it('un reporte y un snapshot a la misma hora se ordenan por id', () => {
    // El reporte se crea primero, así que su id es menor: abre el corte manual
    const reportFirst = [snap(0, true, true), report(10, 'sin_luz'), snap(10, false, false)];
    expect(base(reportFirst)).toEqual([
      { start: at(10), end: null, status: 'abierto', confidence: 'manual', confirmed: null },
    ]);
    expect(base([...reportFirst].reverse())).toEqual(base(reportFirst));
    // Con el snapshot primero, abre la regla base y el sin_luz ya no cambia nada
    const snapshotFirst = [snap(0, true, true), snap(10, false, false), report(10, 'sin_luz')];
    expect(base(snapshotFirst)).toEqual([
      { start: at(10), end: null, status: 'abierto', confidence: 'alta', confirmed: null },
    ]);
    expect(base([...snapshotFirst].reverse())).toEqual(base(snapshotFirst));
  });
});
