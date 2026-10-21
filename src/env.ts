import type postgres from 'postgres';
import type { Db } from './db/client';
import type { HomeMode } from './domain/detection/types';
import type { HomeStatus } from './domain/homes/schema';

/**
 * La parte del binding Rate Limiting de Workers (`RateLimit`) que usa la app. Se declara aquí
 * para que los tests en Node no dependan de los tipos de Workers.
 */
export type RateLimiter = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

export type RateLimitBinding = 'RATE_LIMIT_REGISTER' | 'RATE_LIMIT_EVENTS' | 'RATE_LIMIT_API';

export type Bindings = {
  HYPERDRIVE: { connectionString: string };
  RATE_LIMIT_REGISTER: RateLimiter;
  RATE_LIMIT_EVENTS: RateLimiter;
  RATE_LIMIT_API: RateLimiter;
  ENVIRONMENT: string;
  EXPOSE_DOCS?: string;
};

/** El dispositivo autenticado y el resumen de su casa, salidos de la consulta de auth. */
export type AuthedDevice = {
  id: string;
  homeId: string | null;
  home: {
    mode: HomeMode;
    state: HomeStatus['state'];
    since: number;
    alias: string;
    openOutageStart: number | null;
  } | null;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    device: AuthedDevice;
    tokenHash: string;
    /** Cliente de la petición: postgres.js conecta recién en la primera consulta. */
    sql: postgres.Sql;
    db: Db;
  };
};
