import { describe, expect, it } from 'vitest';
import type { DeviceEvent, ReportEvent, SnapshotEvent } from '../events/schema';
import { detectOutages } from './detect-outages';
import type { HomeMode } from './types';

// PRNG mulberry32: semilla fija, así el test es determinista
const prng = (seed: number) => {
  let a = seed;
  return (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const T0 = Date.UTC(2026, 10, 1, 22, 0);
const MIN = 60_000;
// Saltos alrededor de los umbrales (3 y 10 min); el 0 provoca empates de hora
const GAPS_MIN = [0, 1, 2, 3, 4, 8, 11, 30, 90];
const CASES = 3000;

const makeCase = (random: () => number) => {
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)] as T;
  let n = 0;
  const id = (): string => `00000000-0000-7000-8000-${String(++n).padStart(12, '0')}`;

  const events: DeviceEvent[] = [];
  let t = T0;
  const count = 1 + Math.floor(random() * 12);
  for (let i = 0; i < count; i++) {
    t += pick(GAPS_MIN) * MIN + Math.floor(random() * 3) * 1000;
    if (random() < 0.15) {
      const r: ReportEvent = {
        kind: 'report',
        id: id(),
        at: t,
        value: pick(['sin_luz', 'hay_luz', 'fluctuando'] as const),
      };
      events.push(r);
      continue;
    }
    const onWifi = random() < 0.5;
    const s: SnapshotEvent = {
      kind: 'snapshot',
      id: id(),
      at: t,
      source: 'heartbeat',
      plugged: random() < 0.5,
      onWifi,
      homeWifi: pick([true, false, null] as const),
      internet: onWifi ? pick([true, false, null] as const) : null,
      interactive: pick([true, false, null] as const),
      batteryPct: 80,
    };
    events.push(s);
  }

  // Copia de un snapshot entre él y el evento siguiente
  const sorted = [...events].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  const indexes = sorted.flatMap((e, i) => (e.kind === 'snapshot' ? [i] : []));
  if (indexes.length === 0) return null;
  const i = pick(indexes);
  const original = sorted[i] as SnapshotEvent;
  const nextAt = sorted[i + 1]?.at ?? original.at + 120 * MIN;
  if (nextAt - original.at < 2) return null;
  const copyAt = original.at + 1 + Math.floor(random() * (nextAt - original.at - 1));
  const copy: SnapshotEvent = { ...original, id: id(), at: copyAt };
  return { events, withCopy: [...events, copy] };
};

describe('detectOutages (propiedad)', () => {
  for (const mode of ['base', 'ups'] as const satisfies readonly HomeMode[]) {
    it(`repetir un snapshot no cambia el resultado (modo ${mode})`, () => {
      const random = prng(20261020);
      let checked = 0;
      for (let c = 0; c < CASES; c++) {
        const generated = makeCase(random);
        if (!generated) continue;
        checked++;
        const expected = detectOutages(generated.events, { mode });
        const actual = detectOutages(generated.withCopy, { mode });
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          // El caso mínimo sale en el mensaje para reproducirlo a mano
          expect({ withCopy: generated.withCopy, actual }).toEqual({
            withCopy: generated.withCopy,
            actual: expected,
          });
        }
      }
      expect(checked).toBeGreaterThan(CASES / 2);
    });
  }
});
