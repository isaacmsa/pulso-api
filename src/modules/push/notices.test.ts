import { describe, expect, it } from 'vitest';
import { buildMessages, type Notice, type NoticeKind } from './notices';

const START = Date.UTC(2026, 9, 21, 22, 5); // 6:05 p. m. en Caracas
const END = Date.UTC(2026, 9, 22, 0, 15);

function notice(kind: NoticeKind): Notice {
  return {
    kind,
    homeId: 'home-1',
    outageStart: START,
    outageEnd: kind === 'start' ? null : END,
    alias: 'Mi casa',
    targets: [{ deviceId: 'device-1', pushToken: 'ExponentPushToken[uno]', alias: 'Casa de mamá' }],
  };
}

describe('buildMessages', () => {
  it.each(['start', 'return', 'late', 'return_plain', 'confirm'] as const)(
    'el aviso %s sale con prioridad alta y por el canal de cortes',
    (kind) => {
      const [message] = buildMessages([notice(kind)]);
      expect(message).toMatchObject({ priority: 'high', channelId: 'cortes' });
    },
  );

  it('un mensaje por destinatario, sin tokens en el data', () => {
    const messages = buildMessages([
      {
        ...notice('start'),
        targets: [
          { deviceId: 'a', pushToken: 'ExponentPushToken[a]', alias: 'A' },
          { deviceId: 'b', pushToken: 'ExponentPushToken[b]', alias: 'B' },
        ],
      },
    ]);
    expect(messages.map((m) => [m.deviceId, m.to])).toEqual([
      ['a', 'ExponentPushToken[a]'],
      ['b', 'ExponentPushToken[b]'],
    ]);
    expect(JSON.stringify(messages.map((m) => m.data))).not.toContain('ExponentPushToken');
  });
});
