import type { DeviceEvent } from '../../src/domain/events/schema';

// Los botones son la verdad del spike: el detector se mide solo con snapshots y confirmaciones
export const detectorInput = (events: readonly DeviceEvent[]): DeviceEvent[] =>
  events.filter((e) => e.kind !== 'report');
