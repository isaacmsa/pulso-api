import type { Bindings } from './env';
import workerModule from './index';

// Solo lo compila tsconfig.worker.json, con los tipos que genera `pnpm cf-typegen`: falla si
// los bindings de wrangler.jsonc dejan de encajar con los que usa la app.
export const workerEnvMatchesBindings = (env: Env): Bindings => env;

// El export por defecto de `src/index.ts` (fetch y scheduled) tiene que encajar con el handler
// que espera el runtime.
export const defaultExportIsExportedHandler: ExportedHandler<Env> = workerModule;
