import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../env';

const end = vi.fn(async () => {});
const fakeSql = { end };
const createDb = vi.fn(() => ({ sql: fakeSql, db: {} }));
const runRetention = vi.fn(async () => ({
  events: 3,
  inactiveDevices: 1,
  homes: 1,
  unusedDevices: 2,
}));

vi.mock('../db/client', () => ({ createDb }));
vi.mock('./retention', () => ({ runRetention }));

const { scheduled, RETENTION_CRON } = await import('./scheduled');

const env = { HYPERDRIVE: { connectionString: 'postgres://fake' } } as Bindings;
const ctx = { waitUntil: () => {} };

function controller(cron: string) {
  return { cron, scheduledTime: 1_800_000_000_000 };
}

describe('scheduled', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('con un cron desconocido avisa en el log y no toca la base', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await scheduled(controller('*/5 * * * *'), env, ctx);

    expect(warn).toHaveBeenCalledOnce();
    expect(createDb).not.toHaveBeenCalled();
    expect(runRetention).not.toHaveBeenCalled();
  });

  it('con el cron de retención corre la retención a la hora programada y cierra el cliente', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await scheduled(controller(RETENTION_CRON), env, ctx);

    expect(RETENTION_CRON).toBe('0 8 * * *');
    expect(createDb).toHaveBeenCalledWith('postgres://fake');
    expect(runRetention).toHaveBeenCalledWith(fakeSql, 1_800_000_000_000);
    expect(end).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
  });

  it('si la retención falla cierra el cliente y deja que el cron falle', async () => {
    runRetention.mockRejectedValueOnce(new Error('se cayó la base'));

    await expect(scheduled(controller(RETENTION_CRON), env, ctx)).rejects.toThrow('se cayó');
    expect(end).toHaveBeenCalledOnce();
  });
});
