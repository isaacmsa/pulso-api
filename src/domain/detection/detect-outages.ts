import type { DeviceEvent, ReportEvent, SnapshotEvent } from '../events/schema';
import { MIN_OUTAGE_MS, TRANSITION_MS } from './constants';
import type { DetectedOutage, HomeMode } from './types';

type OpenOutage = { start: number; confidence: DetectedOutage['confidence'] };

type DetectionState = {
  armed: boolean; // el último snapshot relevante decía que la casa tenía luz
  transitionStart: number | null; // dejó de cargar con Wi-Fi de casa todavía arriba
  open: OpenOutage | null;
  pluggedAt: number | null; // volvió la carga pero el router aún no levanta
  prevPowered: boolean; // el snapshot anterior (en orden) era powered
};

type StepResult = { state: DetectionState; closed: DetectedOutage | null };

const INITIAL_STATE: DetectionState = {
  armed: false,
  transitionStart: null,
  open: null,
  pluggedAt: null,
  prevPowered: false,
};

const atHome = (s: SnapshotEvent): boolean => s.homeWifi ?? s.onWifi;
const powered = (s: SnapshotEvent): boolean => s.plugged && atHome(s);

type TimelineEvent = SnapshotEvent | ReportEvent;

const byTimeThenId = (a: TimelineEvent, b: TimelineEvent): number =>
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

// Un corte que dura menos de MIN_OUTAGE_MS es un bajón.
const statusAt = (open: OpenOutage, end: number): 'cerrado' | 'descartado' =>
  end - open.start >= MIN_OUTAGE_MS ? 'cerrado' : 'descartado';

const closedOutage = (
  open: OpenOutage,
  end: number,
  status: 'cerrado' | 'descartado',
): DetectedOutage => ({
  start: open.start,
  end,
  status,
  confidence: open.confidence,
  confirmed: null,
});

const closeOutage = (
  open: OpenOutage,
  end: number,
  status: 'cerrado' | 'descartado',
  s: SnapshotEvent,
): StepResult => ({
  state: {
    armed: powered(s),
    transitionStart: null,
    open: null,
    pluggedAt: null,
    prevPowered: powered(s),
  },
  closed: closedOutage(open, end, status),
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
    return closeOutage(open, end, statusAt(open, end), s);
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

// Modo UPS: el Wi-Fi sigue arriba durante el corte, así que solo la carga manda.
const stepUps = (state: DetectionState, s: SnapshotEvent): StepResult => {
  if (state.open === null) {
    if (state.prevPowered && !s.plugged && atHome(s) && s.interactive === false) {
      return {
        state: {
          ...state,
          armed: false,
          transitionStart: null,
          open: { start: s.at, confidence: 'media' },
          pluggedAt: null,
        },
        closed: null,
      };
    }
    // Corriente y Wi-Fi juntos: la regla del modo base abre con 'alta'.
    return { state: stepBaseIdle(state, s), closed: null };
  }
  if (s.plugged) {
    const end = s.at;
    return closeOutage(state.open, end, statusAt(state.open, end), s);
  }
  // Otra red: no sabe nada de la casa. Cualquier otra cosa lo deja abierto.
  if (s.onWifi && s.homeWifi === false) return closeOutage(state.open, s.at, 'descartado', s);
  return { state, closed: null };
};

// Corte manual abierto: solo lo cierra un snapshot que entra en powered.
// Uno repetido no lo cierra (el teléfono solo sube cambios).
const stepManualOpen = (state: DetectionState, open: OpenOutage, s: SnapshotEvent): StepResult =>
  powered(s) && !state.prevPowered
    ? closeOutage(open, s.at, statusAt(open, s.at), s)
    : { state, closed: null };

const stepSnapshot = (mode: HomeMode, state: DetectionState, s: SnapshotEvent): StepResult => {
  if (state.open?.confidence === 'manual') return stepManualOpen(state, state.open, s);
  return mode === 'ups' ? stepUps(state, s) : stepBase(state, s);
};

// Un reporte no trae estado de carga: prevPowered sigue al último snapshot.
const stepReport = (state: DetectionState, r: ReportEvent): StepResult => {
  if (r.value === 'sin_luz' && state.open === null) {
    return {
      state: {
        ...state,
        armed: false,
        transitionStart: null,
        open: { start: r.at, confidence: 'manual' },
        pluggedAt: null,
      },
      closed: null,
    };
  }
  if (r.value === 'hay_luz' && state.open !== null) {
    return {
      state: {
        ...state,
        armed: state.prevPowered,
        transitionStart: null,
        open: null,
        pluggedAt: null,
      },
      closed: closedOutage(state.open, r.at, statusAt(state.open, r.at)),
    };
  }
  return { state, closed: null };
};

export function detectOutages(
  events: readonly DeviceEvent[],
  options: { mode: HomeMode },
): DetectedOutage[] {
  const timeline = events
    .filter((e): e is TimelineEvent => e.kind === 'snapshot' || e.kind === 'report')
    .sort(byTimeThenId);

  const outages: DetectedOutage[] = [];
  let state = INITIAL_STATE;
  for (const e of timeline) {
    if (e.kind === 'report') {
      const result = stepReport(state, e);
      state = result.state;
      if (result.closed) outages.push(result.closed);
    } else {
      const result = stepSnapshot(options.mode, state, e);
      state = { ...result.state, prevPowered: powered(e) };
      if (result.closed) outages.push(result.closed);
    }
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
