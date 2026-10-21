import type { Bindings } from './env';

// Solo lo compila tsconfig.worker.json, con los tipos que genera `pnpm cf-typegen`: falla si
// los bindings de wrangler.jsonc dejan de encajar con los que usa la app.
export const workerEnvMatchesBindings = (env: Env): Bindings => env;
