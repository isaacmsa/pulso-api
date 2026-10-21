import { describe, expect, it } from 'vitest';
import { at } from '../../testing/builders';
import { deriveHomeStatus } from './home-status';
import type { DetectedOutage } from './types';

const o = (s: number, e: number | null): DetectedOutage => ({
  start: at(s),
  end: e === null ? null : at(e),
  status: e === null ? 'abierto' : 'cerrado',
  confidence: 'alta',
  confirmed: null,
});

describe('deriveHomeStatus', () => {
  const prev = { state: 'con_luz' as const, since: at(0) };

  it('un corte abierto pone sin_luz desde su inicio', () =>
    expect(deriveHomeStatus(prev, [o(5, null)], at(10))).toEqual({
      state: 'sin_luz',
      since: at(5),
    }));

  it('sin cambios se queda con_luz con su hora', () =>
    expect(deriveHomeStatus(prev, [], at(10))).toEqual(prev));

  it('al cerrarse vuelve a con_luz desde el fin', () =>
    expect(deriveHomeStatus({ state: 'sin_luz', since: at(5) }, [o(5, 125)], at(130))).toEqual({
      state: 'con_luz',
      since: at(125),
    }));

  it('sin_noticias con un lote vuelve a con_luz desde ahora', () =>
    expect(deriveHomeStatus({ state: 'sin_noticias', since: at(50) }, [], at(130))).toEqual({
      state: 'con_luz',
      since: at(130),
    }));

  it('con varios cortes abiertos usa el de inicio más tardío', () =>
    expect(deriveHomeStatus(prev, [o(5, null), o(8, null)], at(10))).toEqual({
      state: 'sin_luz',
      since: at(8),
    }));

  it('ignora los fines anteriores al estado previo', () =>
    expect(deriveHomeStatus({ state: 'sin_luz', since: at(200) }, [o(5, 125)], at(300))).toEqual({
      state: 'con_luz',
      since: at(300),
    }));
});
