import { caracasDate } from '../../domain/time/caracas';
import {
  formatClock,
  formatDuration,
  formatShortDate,
  shownDurationMs,
} from '../../domain/time/format';
import { Layout } from './layout';
import type { FamilyHome } from './repo';

/**
 * "las 2:30 p. m." si es de hoy en Caracas; "el 28 oct a las 2:30 p. m." si no, para que un
 * estado de ayer no se lea como de hoy.
 */
function moment(ts: number, now: number): { sameDay: boolean; text: string } {
  const clock = formatClock(ts);
  if (caracasDate(ts) === caracasDate(now)) return { sameDay: true, text: `las ${clock}` };
  return { sameDay: false, text: `el ${formatShortDate(ts)} a las ${clock}` };
}

/** Uno de los tres textos de `pulso-app/docs/product.md` (tabla de estados). */
export function statusText(home: FamilyHome, now: number): string {
  switch (home.state) {
    case 'con_luz':
      return `Hay luz desde ${moment(home.since, now).text}`;
    case 'sin_noticias':
      return `Sin noticias de la casa desde ${moment(home.since, now).text}`;
    case 'sin_luz': {
      // el corte abierto es lo que se cuenta; `since` solo si por algún motivo no hay ninguno. La
      // duración sale de las horas que se muestran, igual que en los push (`shownDurationMs`).
      const start = home.openOutageStart ?? home.since;
      const { sameDay, text } = moment(start, now);
      return `Se fue la luz ${sameDay ? 'a ' : ''}${text} (${formatDuration(shownDurationMs(start, now))})`;
    }
  }
}

export const ANDROID_PACKAGE = 'com.isaacmendoza.pulso';

/**
 * A dónde lleva "Abrir en Pulso". En Android, un `intent:` que abre la app y, si no está
 * instalada, vuelve a esta misma página (`S.browser_fallback_url`; en la fase 5 puede apuntar a la
 * ficha de Play, A-048). Fuera de Android, el enlace de siempre: los App Links cubren el resto.
 * `origin` es el de la petición (`https://host`): en el `intent:` el esquema va aparte.
 */
export function openInAppHref({
  code,
  origin,
  android,
}: {
  code: string;
  origin: string;
  android: boolean;
}): string {
  if (!android) return `/c/${code}`;
  const { host } = new URL(origin);
  const fallback = encodeURIComponent(`${origin}/c/${code}`);
  return `intent://${host}/c/${code}#Intent;scheme=https;package=${ANDROID_PACKAGE};S.browser_fallback_url=${fallback};end`;
}

export function FamilyPage({
  code,
  home,
  now,
  openHref = `/c/${code}`,
}: {
  code: string;
  home: FamilyHome;
  now: number;
  openHref?: string;
}) {
  return (
    <Layout title={`${home.alias} · Pulso`}>
      <h1>{home.alias}</h1>
      <p class="status">{statusText(home, now)}</p>
      <a class="btn" href={openHref}>
        Abrir en Pulso
      </a>
      <p class="muted">Recarga la página para ver el estado más reciente.</p>
    </Layout>
  );
}

export function FamilyNotFound() {
  return (
    <Layout title="Código no encontrado · Pulso">
      <h1>Ese código no existe</h1>
      <p>
        Revisa que esté bien escrito, o pídele a quien te lo mandó que te comparta el enlace de
        nuevo.
      </p>
    </Layout>
  );
}
