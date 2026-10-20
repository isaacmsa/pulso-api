import { describe, expect, it } from 'vitest';
import { at, confirmation } from '../../testing/builders';
import { applyConfirmations } from './apply-confirmations';
import type { DetectedOutage } from './types';

const closed: DetectedOutage = {
  start: at(5),
  end: at(125),
  status: 'cerrado',
  confidence: 'alta',
  confirmed: null,
};

describe('applyConfirmations', () => {
  it('answer false descarta el corte', () => {
    expect(applyConfirmations([closed], [confirmation(130, 5, false)])).toEqual([
      { ...closed, status: 'descartado', confirmed: false },
    ]);
  });
  it('answer true lo confirma', () => {
    expect(applyConfirmations([closed], [confirmation(130, 5, true)])).toEqual([
      { ...closed, confirmed: true },
    ]);
  });
  it('tolera hasta 5 min de diferencia en outageStart', () => {
    expect(applyConfirmations([closed], [confirmation(130, 9, true)])).toEqual([
      { ...closed, confirmed: true },
    ]);
  });
  it('una confirmación sin corte cercano se ignora', () => {
    expect(applyConfirmations([closed], [confirmation(130, 20, false)])).toEqual([closed]);
  });
  it('la última confirmación manda', () => {
    expect(
      applyConfirmations([closed], [confirmation(140, 5, false), confirmation(130, 5, true)]),
    ).toEqual([{ ...closed, status: 'descartado', confirmed: false }]);
  });
});
