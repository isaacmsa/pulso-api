import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../src/index';
import { buildOpenApiDocument, serializeOpenApi } from '../src/openapi';

// Escribe el contrato (`openapi.json` en la raíz) a partir de las rutas de `createApp()`. No usa
// variables de entorno ni base: el documento sale solo de los esquemas.
// Uso: `pnpm openapi:export [archivo]` (sin argumento escribe `openapi.json`).
// `pnpm openapi:check` lo regenera en un temporal y falla si difiere del versionado.

const target = resolve(process.argv[2] ?? 'openapi.json');
writeFileSync(target, serializeOpenApi(buildOpenApiDocument(createApp())));
console.log(`Contrato escrito en ${target}`);
