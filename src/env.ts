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

export type RateLimitBinding =
  | 'RATE_LIMIT_REGISTER'
  | 'RATE_LIMIT_EVENTS'
  | 'RATE_LIMIT_API'
  | 'RATE_LIMIT_PUBLIC';

export type Bindings = {
  HYPERDRIVE: { connectionString: string };
  RATE_LIMIT_REGISTER: RateLimiter;
  RATE_LIMIT_EVENTS: RateLimiter;
  RATE_LIMIT_API: RateLimiter;
  /** Rutas públicas (`/health`; en la fase 3, `/c/:code`): por IP, 60 por minuto. */
  RATE_LIMIT_PUBLIC: RateLimiter;
  /** Secreto de Worker: base64url de al menos 32 bytes con el que se firman los tokens. */
  TOKEN_SIGNING_KEY: string;
  /** Secreto de Worker, opcional: token de acceso de Expo Push ("enhanced push security"). */
  EXPO_ACCESS_TOKEN?: string;
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
    /** La hora del Worker (epoch ms). `Date.now` salvo en los tests, que la fijan con `createApp`. */
    now: () => number;
  };
};
