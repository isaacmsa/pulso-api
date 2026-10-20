import { describe, expect, it } from 'vitest';
import { at, snap } from '../../testing/builders';
import type { DeviceEvent } from '../events/schema';
import { detectOutages } from './detect-outages';
import type { DetectedOutage } from './types';

const base = (events: DeviceEvent[]) => detectOutages(events, { mode: 'base' });
const outage = (
  startMin: number,
  endMin: number | null,
  status: DetectedOutage['status'],
  confidence: DetectedOutage['confidence'] = 'alta',
): DetectedOutage => ({
  start: at(startMin),
  end: endMin === null ? null : at(endMin),
  status,
  confidence,
  confirmed: null,
});

describe('detectOutages (modo base)', () => {
  it('cierra cuando vuelven corriente y Wi-Fi', () => {
    expect(base([snap(0, true, true), snap(5, false, false), snap(125, true, true)])).toEqual([
      outage(5, 125, 'cerrado'),
    ]);
  });
  it('descarta caídas de menos de 10 min', () => {
    expect(base([snap(0, true, true), snap(5, false, false), snap(9, true, true)])).toEqual([
      outage(5, 9, 'descartado'),
    ]);
  });
  it('descarta Wi-Fi desconocido sin carga', () => {
    expect(base([snap(0, true, true), snap(20, false, false), snap(90, false, true)])).toEqual([
      outage(20, 90, 'descartado'),
    ]);
  });
  it('sigue abierto mientras arranca el router', () => {
    expect(base([snap(0, true, true), snap(5, false, false), snap(60, true, false)])).toEqual([
      outage(5, null, 'abierto'),
    ]);
  });
  it('tolera señales desordenadas', () => {
    expect(base([snap(125, true, true), snap(0, true, true), snap(5, false, false)])).toEqual([
      outage(5, 125, 'cerrado'),
    ]);
  });
  it('abre aunque llegue una señal intermedia de transición', () => {
    expect(
      base([
        snap(0, true, true),
        snap(5, false, true),
        snap(6, false, false),
        snap(100, true, true),
      ]),
    ).toEqual([outage(5, 100, 'cerrado')]);
  });
  it('no abre si el Wi-Fi se cae después de TRANSITION_MS', () => {
    expect(base([snap(0, true, true), snap(5, false, true), snap(30, false, false)])).toEqual([]);
  });
  it('no abre si cargaba fuera de casa', () => {
    expect(base([snap(0, true, false), snap(5, false, false)])).toEqual([]);
  });
  it('el fin es la hora en que volvió la corriente', () => {
    expect(
      base([
        snap(0, true, true),
        snap(5, false, false),
        snap(120, true, false),
        snap(122, true, true),
      ]),
    ).toEqual([outage(5, 120, 'cerrado')]);
  });
  it('un parpadeo mientras arranca el router mueve el fin', () => {
    expect(
      base([
        snap(0, true, true),
        snap(5, false, false),
        snap(120, true, false),
        snap(121, false, false),
        snap(130, true, true),
      ]),
    ).toEqual([outage(5, 130, 'cerrado')]);
  });
  it('el Wi-Fi de casa sin corriente cierra el corte', () => {
    expect(
      base([
        snap(0, true, true, { homeWifi: true }),
        snap(5, false, false, { homeWifi: false }),
        snap(100, false, true, { homeWifi: true }),
      ]),
    ).toEqual([outage(5, 100, 'cerrado')]);
  });
  it('otra red Wi-Fi no cierra el corte', () => {
    expect(
      base([
        snap(0, true, true, { homeWifi: true }),
        snap(5, false, false, { homeWifi: false }),
        snap(40, false, true, { homeWifi: false }),
      ]),
    ).toEqual([outage(5, null, 'abierto')]);
  });
  it('snapshots repetidos no cambian el resultado', () => {
    expect(
      base([
        snap(0, true, true),
        snap(1, true, true),
        snap(5, false, false),
        snap(30, false, false),
        snap(60, false, false),
        snap(125, true, true),
        snap(126, true, true),
      ]),
    ).toEqual([outage(5, 125, 'cerrado')]);
  });
  it('no depende del orden de entrada con empate de hora', () => {
    const events = [
      snap(0, true, true),
      snap(5, false, true),
      snap(5, false, false),
      snap(100, true, true),
    ];
    expect(base([...events].reverse())).toEqual(base(events));
    expect(base(events)).toEqual([outage(5, 100, 'cerrado')]);
  });
  it('reiniciar enchufado durante el corte lo cierra', () => {
    expect(
      base([snap(0, true, true), snap(5, false, false), snap(600, true, true, { source: 'boot' })]),
    ).toEqual([outage(5, 600, 'cerrado')]);
  });
});
