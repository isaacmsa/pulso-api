# Decisiones del backend

**Qué responde este documento**

- Qué se decidió dentro de `pulso-api`, cuándo y por qué
- Qué se sacrificó

Las decisiones del producto (dos repos, stack, dónde vive el clasificador, contrato OpenAPI, idempotencia, casas y dispositivos) están en `pulso-app/docs/decisions.md` como D-0xx. Aquí van las internas, con prefijo `A-`.

| Id | Fecha | Decisión | Por qué | Lo que se sacrifica |
| --- | --- | --- | --- | --- |
| A-001 | 2026-10-20 | Un solo paquete pnpm: `src/domain` puro y `src/modules` por dominio | El repo hace una sola cosa. `domain/` se testea en Node sin el runtime de Workers | |
| A-002 | 2026-10-20 | Rutas con `@hono/zod-openapi` (Zod 4); `openapi.json` versionado y verificado en CI con `pnpm openapi:check` | El mismo esquema valida y documenta, y la app genera su cliente desde un archivo estable | Cada ruta se declara con `createRoute`, algo más verboso que Hono simple |
| A-003 | 2026-10-20 | PostgreSQL en Supabase gratis, usado solo como base, conectado por Hyperdrive con postgres.js; Drizzle ORM y migraciones de `drizzle-kit` | USD 0 sin tarjeta, y PostgreSQL en el portafolio. Hyperdrive mantiene el pool de conexiones, así que cada petición del Worker no abre una conexión nueva | Dos servicios en vez de uno. Techo de 100.000 consultas al día en Hyperdrive gratis. Supabase pausa los proyectos tras una semana sin uso |
| A-004 | 2026-10-20 | Ingesta en funciones de PostgreSQL (`app.ingest_batch`, `app.apply_outages`) y autenticación más latido en un solo `UPDATE … RETURNING` | Con ~2 consultas por petición, el techo gratis de Hyperdrive sube de ~300 a ~600 teléfonos, y cada lote es atómico | Algo de lógica en SQL. Se versiona en las migraciones y la cubren los tests de integración. El clasificador sigue en TypeScript |
| A-005 | 2026-10-20 | Tablas en el esquema `app`, con RLS activado sin políticas y un rol `pulso_api` dueño del esquema | Supabase expone `public` en su API REST. Así nada de Pulso es legible con la clave `anon`, aunque se filtrara | Un paso más al crear cada proyecto (lo hace la migración inicial) |
| A-006 | 2026-10-20 | `payload` de los eventos en `jsonb` | Los campos del snapshot van a cambiar con la prueba técnica; agregar uno no exige migración | Las consultas dentro del payload son menos directas (no hacen falta en la v1) |
| A-007 | 2026-10-20 | Horas como epoch ms en `bigint`, igual que en el contrato, en lugar de `timestamptz` | Una sola representación de punta a punta: el clasificador, el contrato y la base hablan igual | El SQL a mano es menos legible: usar `to_timestamp(at / 1000.0)` al inspeccionar |
| A-008 | 2026-10-20 | Vitest en Node para todo; repositorios y rutas (`app.request()`) contra un PostgreSQL real (local con `compose.dev.yaml`, en CI con `services:`) | Hono y postgres.js corren igual en Node, así que no hace falta el pool de Workers para probar SQL de verdad | No se prueba el runtime exacto de Workers en los tests: lo cubre el despliegue a staging |
| A-009 | 2026-10-20 | Límites con el binding Rate Limiting, por dispositivo salvo en el registro y las páginas públicas | CGNAT: muchos usuarios venezolanos comparten IP y suben a la vez cuando vuelve la luz | El límite por IP del registro tiene que ser holgado (30 por hora) |
| A-010 | 2026-10-20 | Respaldo nocturno propio con `pg_dump` cifrado desde GitHub Actions | El plan gratuito de Supabase no incluye respaldos descargables | Los artefactos de GitHub duran como mucho 90 días; se guardan 14 |
| A-011 | 2026-10-20 | `pnpm spike:analyze` vive aquí, en `scripts/spike/` | Necesita el clasificador, y el clasificador vive solo en el backend | Para analizar un exporte hay que tener este repo clonado |
| A-012 | 2026-10-20 | Una confirmación que cae en la tolerancia de varios cortes va al de `start` más cercano (en empate, al más temprano). `hay_luz` cierra en su `at` y rearma según el último snapshot; un corte manual solo lo cierra un snapshot que entra en `powered` | `docs/classifier.md` dice "el corte cuyo `start` esté dentro de la tolerancia" pero no qué pasa con varios. Un reporte no trae estado de carga | Un reporte no cambia `prevPowered`: el "entra en powered" se mide siempre contra el snapshot anterior |
