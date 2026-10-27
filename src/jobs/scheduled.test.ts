import { readFileSync } from 'node:fs';
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

const runSweep = vi.fn(async () => ({
  starts: 1,
  push: { sent: 2, saved: 2, cleared: 0, errors: {} },
  receipts: { read: 0, cleared: 0, retried: 0, expired: 0, errors: {} },
}));

vi.mock('../db/client', () => ({ createDb }));
vi.mock('./retention', () => ({ runRetention }));
vi.mock('./sweep', () => ({ runSweep }));

const { scheduled, RETENTION_CRON, SWEEP_CRON } = await import('./scheduled');

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

    await scheduled(controller('0 0 1 1 *'), env, ctx);

    expect(warn).toHaveBeenCalledOnce();
    expect(createDb).not.toHaveBeenCalled();
    expect(runRetention).not.toHaveBeenCalled();
    expect(runSweep).not.toHaveBeenCalled();
  });

  it('con el cron de sweep corre el sweep a la hora programada y deja el resumen en el log', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await scheduled(controller(SWEEP_CRON), env, ctx);

    expect(SWEEP_CRON).toBe('*/5 * * * *');
    expect(runSweep).toHaveBeenCalledWith(env, 1_800_000_000_000);
    expect(runRetention).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]?.[0])).toContain('"job":"sweep"');
  });

  it('staging y producción declaran en wrangler.jsonc los dos crons que se despachan', () => {
    const config = readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8');
    const declared = [...config.matchAll(/"crons":\s*\[([^\]]*)\]/g)].map((m) =>
      JSON.parse(`[${m[1]}]`),
    );

    expect(declared).toEqual([
      [SWEEP_CRON, RETENTION_CRON],
      [SWEEP_CRON, RETENTION_CRON],
    ]);
  });

  it('si el sweep falla deja el error en el log y deja que el cron falle', async () => {
    runSweep.mockRejectedValueOnce(new Error('se cayó la base'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(scheduled(controller(SWEEP_CRON), env, ctx)).rejects.toThrow('se cayó');
    expect(error).toHaveBeenCalledOnce();
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

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(scheduled(controller(RETENTION_CRON), env, ctx)).rejects.toThrow('se cayó');
    expect(end).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  });

  it('si cerrar el cliente también falla, el error que sale es el de la retención', async () => {
    runRetention.mockRejectedValueOnce(new Error('se cayó la base'));
    end.mockRejectedValueOnce(new Error('no cierra'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(scheduled(controller(RETENTION_CRON), env, ctx)).rejects.toThrow('se cayó');
  });
});
