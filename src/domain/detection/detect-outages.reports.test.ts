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
});
