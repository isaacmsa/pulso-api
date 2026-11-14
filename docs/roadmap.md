# Roadmap del backend

**Qué responde este documento**

- Dónde está el estado del backend y lo que le falta
- Qué le toca a este repo en cada fase del tablero maestro
- Qué construyó el backend en las fases 0 a 5 del plan anterior

El estado de Pulso vive en un solo lugar: el tablero maestro, `pulso-app/docs/roadmap.md` (en `~/projects/personal/mobile/pulso-app`), con sus archivos de fase en `pulso-app/docs/phases/`. Aquí no se marca nada (D-046 de la app): este documento dice qué le toca al backend en cada fase y guarda el registro de lo construido.

Staging: `https://pulso-api-staging.isaac-mendozasa.workers.dev`. Producción todavía no existe: es la fase 7 del tablero.

## Lo que le toca a este repo

| Fase del tablero | Qué hace el backend |
| --- | --- |
| 7 · API en producción con respaldo | Casi todo: Hyperdrive de producción, primer deploy, primer respaldo y su restauración, textos de la política y arreglos chicos del contrato y de los documentos |
| 8 · Detección con datos reales | Analizar los exportes con `pnpm spike:analyze` y un test que valide contra el esquema un evento real con `locked` |
| 9 · Primer build con EAS y push | Huella del keystore de EAS en `ANDROID_CERT_SHA256` de staging |
| 10 · Revisión de seguridad | La revisión de este repo y los hallazgos que las revisiones de fase dejaron aparcados |
| 11 · Play Console y envío de la prueba cerrada | Huella de firma de Play en `ANDROID_CERT_SHA256` de producción (B4), lote real de la versión que se publica y deploy |
| 12 · Prueba cerrada: 14 días con testers | Umbrales con las confirmaciones de los testers (D-013, B7) |
| 13 · Producción y lanzamiento | Lote de la versión de producción (B9) y deploy final |

La fase 6 es solo de la app.

## Lo construido

El detalle de cada tarea, con sus decisiones, está en los planes de `docs/plans/`, que quedan como registro.

### Fase 0 · Contrato y clasificador

- Repo, Biome, Vitest y CI
- Contrato de eventos en Zod
- Clasificador: modo base, modo UPS, reportes y confirmaciones, con todos los tests de `docs/classifier.md`
- Resumen por día en America/Caracas
- `pnpm spike:analyze`

### Fase 1 · API en staging

- Cuentas de Cloudflare y Supabase. Proyecto `pulso-staging` en `us-west-2` (A-026), con el rol `pulso_api` y su Hyperdrive sin caché
- Drizzle: esquema `app` con RLS, PostgreSQL local y Hyperdrive con `localConnectionString`
- Funciones `app.ingest_batch` y `app.apply_outages`, con tests de integración contra PostgreSQL
- Middleware: auth con SHA-256 y latido en un solo `UPDATE … RETURNING`, límites y errores
- `devices` y `homes`: `POST /v1/devices`, `POST /v1/homes`, `PATCH` y `DELETE` en cascada
- `POST /v1/events` con `reconcileOutages` y `deriveHomeStatus`, y `GET /v1/homes/me/status`
- `GET /openapi.json`, `/docs` en staging, `pnpm openapi:export` y `openapi:check`, test de contrato con un lote real y `deploy.yml`

### Fase 2 · Historial, privacidad y producción

- `GET /v1/homes/me/outages` con `summarizeOutages`
- `GET /privacidad` y `GET /borrar-datos`
- Entorno `production` en `wrangler.jsonc`, `deploy-production.yml` con aprobación manual y `backup.yml` con `pg_dump` cifrado. Están sin estrenar: es la fase 7 del tablero

### Fase 3 · Push y familia

- Módulo `push`: envío a Expo Push, `push_tickets`, recibos y limpieza de tokens con `DeviceNotRegistered`
- Reglas de inicio, regreso, resumen tardío y confirmación, sin repetir avisos
- `POST/GET/DELETE /v1/follows` y `POST /v1/homes/me/share-code`
- `GET /c/:code` y `/.well-known/assetlinks.json`, que responde 404 hasta tener la huella de Play (fase 11 del tablero)

### Fase 4 · Robustez

- `sweep`: «sin noticias» (40 min sin latido) y `sin_datos` (A-037, A-038, A-042, A-049)
- Cron `retention` (A-042)
- `@sentry/cloudflare` con filtros, apagado mientras no haya `SENTRY_DSN` (A-039)
- Consulta de confirmaciones para D-013 y script de restauración local de un respaldo

### Fase 5 · Producción

- Límites gratuitos de Workers, Hyperdrive y Supabase confirmados el 2 de noviembre de 2026 (tabla «Costos y techos» de `docs/architecture.md`)
- `docs/runbook.md`: desplegar, volver atrás, restaurar, rotar secretos y reactivar un proyecto pausado
