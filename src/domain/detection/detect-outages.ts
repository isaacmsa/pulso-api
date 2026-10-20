import type { DeviceEvent, SnapshotEvent } from '../events/schema';
import { MIN_OUTAGE_MS, TRANSITION_MS } from './constants';
import type { DetectedOutage, HomeMode } from './types';

type OpenOutage = { start: number; confidence: DetectedOutage['confidence'] };

type DetectionState = {
  armed: boolean; // el último snapshot relevante decía que la casa tenía luz
  transitionStart: number | null; // dejó de cargar con Wi-Fi de casa todavía arriba
  open: OpenOutage | null;
  pluggedAt: number | null; // volvió la carga pero el router aún no levanta
};

type StepResult = { state: DetectionState; closed: DetectedOutage | null };

const INITIAL_STATE: DetectionState = {
  armed: false,
  transitionStart: null,
  open: null,
  pluggedAt: null,
};

const atHome = (s: SnapshotEvent): boolean => s.homeWifi ?? s.onWifi;
const powered = (s: SnapshotEvent): boolean => s.plugged && atHome(s);

const byTimeThenId = (a: SnapshotEvent, b: SnapshotEvent): number =>
  a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Modo base sin corte abierto: armar, seguir la transición o abrir.
const stepBaseIdle = (state: DetectionState, s: SnapshotEvent): DetectionState => {
  if (powered(s)) return { ...state, armed: true, transitionStart: null };
  if (state.armed && !s.plugged && atHome(s)) {
    return { ...state, transitionStart: state.transitionStart ?? s.at };
  }
  if (state.armed && !s.plugged && !atHome(s)) {
    const start = state.transitionStart ?? s.at;
    const open: OpenOutage | null =
      s.at - start <= TRANSITION_MS ? { start, confidence: 'alta' } : null;
    return { ...state, armed: false, transitionStart: null, open, pluggedAt: null };
  }
  return { ...state, armed: false, transitionStart: null };
};

const closeOutage = (
  open: OpenOutage,
  end: number,
  status: 'cerrado' | 'descartado',
  s: SnapshotEvent,
): StepResult => ({
  state: { armed: powered(s), transitionStart: null, open: null, pluggedAt: null },
  closed: { start: open.start, end, status, confidence: open.confidence, confirmed: null },
});

// Modo base con corte abierto: las filas se evalúan en el orden de docs/classifier.md.
const stepBaseOpen = (state: DetectionState, open: OpenOutage, s: SnapshotEvent): StepResult => {
  if (s.plugged && !atHome(s)) {
    return { state: { ...state, pluggedAt: state.pluggedAt ?? s.at }, closed: null };
  }
  if (!s.plugged && !s.onWifi) {
    return { state: { ...state, pluggedAt: null }, closed: null };
  }
  if (atHome(s) && (s.plugged || s.homeWifi === true)) {
    const end = state.pluggedAt ?? s.at;
    return closeOutage(open, end, end - open.start >= MIN_OUTAGE_MS ? 'cerrado' : 'descartado', s);
  }
  if (s.onWifi && !s.plugged && s.homeWifi === null) {
    return closeOutage(open, s.at, 'descartado', s);
  }
  // onWifi && homeWifi === false: otra red, no sabe nada de la casa.
  return { state, closed: null };
};

const stepBase = (state: DetectionState, s: SnapshotEvent): StepResult =>
  state.open === null
    ? { state: stepBaseIdle(state, s), closed: null }
    : stepBaseOpen(state, state.open, s);

export function detectOutages(
  events: readonly DeviceEvent[],
  _options: { mode: HomeMode },
): DetectedOutage[] {
  const snapshots = events
    .filter((e): e is SnapshotEvent => e.kind === 'snapshot')
    .sort(byTimeThenId);

  const outages: DetectedOutage[] = [];
  let state = INITIAL_STATE;
  for (const s of snapshots) {
    const result = stepBase(state, s);
    state = result.state;
    if (result.closed) outages.push(result.closed);
  }

  if (state.open) {
    outages.push({
      start: state.open.start,
      end: null,
      status: 'abierto',
      confidence: state.open.confidence,
      confirmed: null,
    });
  }
  return outages;
}
