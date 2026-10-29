import type postgres from 'postgres';
import {
  confirmationMessage,
  lateSummaryMessage,
  type PushText,
  returnMessage,
  returnWithoutDurationMessage,
  startMessage,
} from '../../domain/push/messages';
import { type ExpoOptions, type PushMessage, sendPushes } from './expo';
import { recordSendResults } from './repo';

/**
 * Qué push sale (docs/api.md, "Cuándo sale cada push"):
 * - `start`: inicio, a los seguidores (cron `sweep`).
 * - `return`: regreso con la duración, si hubo push de inicio.
 * - `late`: resumen tardío, si no lo hubo.
 * - `return_plain`: "volvió la luz" sin duración, de un corte con inicio que terminó descartado (A-034).
 * - `confirm`: "¿Se fue la luz…?", al teléfono de la casa.
 */
export type NoticeKind = 'start' | 'return' | 'late' | 'return_plain' | 'confirm';

/** Un destinatario. `alias` es el nombre que ese seguidor le puso a la casa ("Casa de mamá"). */
export type PushTarget = { deviceId: string; pushToken: string; alias: string };

/** Un aviso ya marcado en `outages` (regla 11): solo queda mandarlo. */
export type Notice = {
  kind: NoticeKind;
  homeId: string;
  outageStart: number;
  outageEnd: number | null;
  /** El alias de la casa (el que puso su dueño). */
  alias: string;
  targets: PushTarget[];
};

function text(notice: Notice, alias: string): PushText {
  const { outageStart: start, outageEnd: end } = notice;
  switch (notice.kind) {
    case 'start':
      return startMessage(alias, start);
    case 'return':
      return end === null ? returnWithoutDurationMessage(alias) : returnMessage(alias, start, end);
    case 'late':
      return end === null
        ? returnWithoutDurationMessage(alias)
        : lateSummaryMessage(alias, start, end);
    case 'return_plain':
      return returnWithoutDurationMessage(alias);
    case 'confirm':
      // un corte cerrado siempre tiene fin; sin él no hay qué preguntar
      return confirmationMessage(start, end ?? start);
  }
}

/**
 * Un mensaje de Expo por destinatario. El `data` lleva lo que la app necesita para abrir la casa
 * (o responder la confirmación), nunca tokens. Todos salen con `priority: 'high'`, incluida la
 * confirmación: un teléfono Android en Doze (el de la casa, sobre todo, que pasa horas quieto) no
 * entrega un aviso de prioridad normal hasta la siguiente ventana de mantenimiento, y cada aviso
 * es una noticia de un corte, no un contenido que pueda esperar.
 */
export function buildMessages(notices: readonly Notice[]): PushMessage[] {
  return notices.flatMap((notice) =>
    notice.targets.map((target): PushMessage => {
      const { title, body } = text(notice, target.alias);
      if (notice.kind === 'confirm') {
        return {
          to: target.pushToken,
          title,
          body,
          data: { type: 'confirm', outageStart: notice.outageStart },
          channelId: 'cortes',
          categoryId: 'confirm_outage',
          priority: 'high',
          deviceId: target.deviceId,
        };
      }
      const type = notice.kind === 'return_plain' ? 'return' : notice.kind;
      return {
        to: target.pushToken,
        title,
        body,
        data: { type, homeId: notice.homeId, outageStart: notice.outageStart },
        channelId: 'cortes',
        priority: 'high',
        deviceId: target.deviceId,
      };
    }),
  );
}

export type SendSummary = {
  sent: number;
  saved: number;
  cleared: number;
  errors: Record<string, number>;
};

/**
 * Manda los avisos ya marcados y guarda sus tickets (1 consulta; 1 más si Expo respondió
 * `DeviceNotRegistered` en el ticket). Los errores de envío no se reintentan: el aviso ya quedó
 * marcado (regla 11). Se registran contados por código, sin tokens. Nunca lanza: corre en
 * `waitUntil` o en el cron, donde un error suelto se perdería.
 */
export async function sendAndRecord(
  sql: postgres.Sql,
  notices: readonly Notice[],
  now: number,
  opts: ExpoOptions,
): Promise<SendSummary> {
  const messages = buildMessages(notices);
  if (messages.length === 0) return { sent: 0, saved: 0, cleared: 0, errors: {} };
  try {
    const results = await sendPushes(messages, opts);
    const recorded = await recordSendResults(sql, results, now);
    if (Object.keys(recorded.errors).length > 0) {
      console.error(JSON.stringify({ job: 'push', errors: recorded.errors }));
    }
    return { sent: messages.length, ...recorded };
  } catch (error) {
    // el mensaje del error, no el objeto: postgres.js adjunta los parámetros (los push_token)
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ job: 'push', error: message }));
    return { sent: messages.length, saved: 0, cleared: 0, errors: { record_failed: 1 } };
  }
}
