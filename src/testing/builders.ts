import type { ConfirmationEvent, ReportEvent, SnapshotEvent } from '../domain/events/schema';

// domingo 1 de noviembre, 6:00 p. m. en Caracas (UTC−4)
export const T0 = Date.UTC(2026, 10, 1, 22, 0);
export const MIN = 60_000;
export const at = (minute: number): number => Math.round(T0 + minute * MIN);

let counter = 0;
const nextId = (): string => `00000000-0000-7000-8000-${String(++counter).padStart(12, '0')}`;

export const snap = (
  minute: number,
  plugged: boolean,
  onWifi: boolean,
  extra: Partial<SnapshotEvent> = {},
): SnapshotEvent => ({
  kind: 'snapshot',
  id: nextId(),
  at: at(minute),
  source: 'heartbeat',
  plugged,
  onWifi,
  homeWifi: null,
  internet: onWifi ? true : null,
  interactive: null,
  batteryPct: 80,
  ...extra,
});

export const report = (minute: number, value: ReportEvent['value']): ReportEvent => ({
  kind: 'report',
  id: nextId(),
  at: at(minute),
  value,
});

export const confirmation = (
  minute: number,
  outageStartMinute: number,
  answer: boolean,
): ConfirmationEvent => ({
  kind: 'confirmation',
  id: nextId(),
  at: at(minute),
  outageStart: at(outageStartMinute),
  answer,
});
