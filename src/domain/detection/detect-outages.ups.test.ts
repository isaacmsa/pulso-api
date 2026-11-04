import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, snap } from '../../testing/builders';
import type { DeviceEvent } from '../events/schema';
import { detectOutages } from './detect-outages';
import type { DetectedOutage } from './types';

const ups = (events: DeviceEvent[]) => detectOutages(events, { mode: 'ups' });
const outage = (
  startMin: number,
  endMin: number | null,
  status: DetectedOutage['status'],
  confidence: DetectedOutage['confidence'] = 'media',
): DetectedOutage => ({
  start: at(startMin),
  end: endMin === null ? null : at(endMin),
  status,
  confidence,
  confirmed: null,
});
const idle = { interactive: false } as const;

describe('detectOutages (modo UPS)', () => {
  it('abre y cierra cuando la corriente se va sola con la pantalla apagada', () => {
    expect(
      ups([snap(0, true, true, idle), snap(5, false, true, idle), snap(95, true, true)]),
    ).toEqual([outage(5, 95, 'cerrado')]);
  });
  it('ignora el desenchufe con la pantalla encendida', () => {
    expect(ups([snap(0, true, true, idle), snap(5, false, true, { interactive: true })])).toEqual(
      [],
    );
  });
  it('abre con la pantalla encendida si el teléfono sigue bloqueado (MIUI la enciende al desenchufar)', () => {
    // Medido en el Redmi A5 el 4 de noviembre: bloqueado y boca abajo, al sacar el cable reporta interactive true.
    expect(
      ups([
        snap(0, true, true, idle),
        snap(5, false, true, { interactive: true, locked: true }),
        snap(95, true, true),
      ]),
    ).toEqual([outage(5, 95, 'cerrado')]);
  });
  it('ignora el desenchufe con la pantalla encendida y el teléfono desbloqueado', () => {
    expect(
      ups([snap(0, true, true, idle), snap(5, false, true, { interactive: true, locked: false })]),
    ).toEqual([]);
  });
  it('sin locked (versiones viejas) sigue mirando solo la pantalla', () => {
    expect(
      ups([snap(0, true, true, idle), snap(5, false, true, { interactive: true, locked: null })]),
    ).toEqual([]);
  });
  it('ignora interactive null', () => {
    expect(ups([snap(0, true, true), snap(5, false, true)])).toEqual([]);
  });
  it('ignora si no estaba en casa', () => {
    expect(ups([snap(0, true, false, idle), snap(5, false, false, idle)])).toEqual([]);
  });
  it('sigue abierto si el UPS se agota', () => {
    expect(
      ups([snap(0, true, true, idle), snap(5, false, true, idle), snap(240, false, false)]),
    ).toEqual([outage(5, null, 'abierto')]);
  });
  it('descarta caídas de menos de 10 min', () => {
    expect(
      ups([snap(0, true, true, idle), snap(5, false, true, idle), snap(8, true, true)]),
    ).toEqual([outage(5, 8, 'descartado')]);
  });
  it('corriente y Wi-Fi juntos abren con alta', () => {
    expect(ups([snap(0, true, true), snap(5, false, false), snap(65, true, true)])).toEqual([
      outage(5, 65, 'cerrado', 'alta'),
    ]);
  });
  it('sigue abierto si al irse la luz el teléfono se pasa a otra red', () => {
    const events = [
      snap(0, true, true, { homeWifi: true }),
      snap(5, false, true, { homeWifi: false }),
    ];
    expect(ups(events)).toEqual([outage(5, null, 'abierto', 'alta')]);
    expect(ups([...events, snap(20, false, true, { homeWifi: false })])).toEqual([
      outage(5, null, 'abierto', 'alta'),
    ]);
  });
  it('snapshots repetidos no cambian el resultado', () => {
    expect(
      ups([
        snap(0, true, true, idle),
        snap(1, true, true, idle),
        snap(5, false, true, idle),
        snap(30, false, true, idle),
        snap(60, false, true, idle),
        snap(95, true, true),
        snap(96, true, true),
      ]),
    ).toEqual([outage(5, 95, 'cerrado')]);
  });
  it('un corte media sigue abierto en Wi-Fi sin huella y sin carga', () => {
    // El descarte del modo base por Wi-Fi desconocido no aplica: con UPS el Wi-Fi sigue arriba
    expect(
      ups([snap(0, true, true, idle), snap(5, false, true, idle), snap(30, false, true)]),
    ).toEqual([outage(5, null, 'abierto')]);
  });
  it('descarta si aparece en otra red', () => {
    expect(
      ups([
        snap(0, true, true, { homeWifi: true, interactive: false }),
        snap(5, false, true, { homeWifi: true, interactive: false }),
        snap(30, false, true, { homeWifi: false }),
      ]),
    ).toEqual([outage(5, 30, 'descartado')]);
  });
});

describe('detectOutages (modo UPS, eventos reales del Redmi A5, 3 y 4 de noviembre)', () => {
  const events = JSON.parse(
    readFileSync(
      new URL('../../../test/fixtures/real/redmi-a5-2026-11-03-ups.json', import.meta.url),
      'utf8',
    ),
  ) as DeviceEvent[];
  const detected = ups(events).filter((o) => o.confidence !== 'manual');

  it('el corte real de las 7:42 p. m. (app 0.1, sin locked y con la pantalla encendida por MIUI) no se abre', () => {
    expect(detected.some((o) => o.start === Date.UTC(2026, 10, 3, 23, 42, 20, 326))).toBe(false);
  });
  it('el desenchufe bloqueado de las 11:09:31 (app 0.2) abre, y el cable de vuelta 28 s después lo descarta', () => {
    expect(detected).toContainEqual(
      expect.objectContaining({
        start: 1793804968348,
        end: 1793804996088,
        status: 'descartado',
        confidence: 'media',
      }),
    );
  });
});
