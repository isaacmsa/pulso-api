import type { DeviceEvent } from '../events/schema';
import { applyConfirmations } from './apply-confirmations';
import { detectOutages } from './detect-outages';
import type { DetectedOutage, HomeMode } from './types';

export function classify(
  events: readonly DeviceEvent[],
  options: { mode: HomeMode },
): DetectedOutage[] {
  return applyConfirmations(detectOutages(events, options), events);
}
