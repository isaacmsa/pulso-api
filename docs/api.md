# API

**Qué responde este documento**

- Qué endpoints existen, quién puede llamarlos y qué devuelven
- Cuál es el contrato de eventos que manda el módulo Kotlin de la app
- Cómo se publica el contrato OpenAPI que consume la app
- Cómo se limitan las peticiones y cuándo sale cada push

Base: `/v1`. El teléfono se autentica con `Authorization: Bearer <token>`. Cada ruta se define con `createRoute` de `@hono/zod-openapi` (A-002): el mismo esquema Zod valida la petición y genera el contrato. `openapi.json` (versionado en la raíz del repo y servido en `GET /openapi.json`) es el contrato que consume la app.

## Endpoints

| Método y ruta | Auth | Para qué | Respuesta | Fase |
| --- | --- | --- | --- | --- |
| `POST /v1/devices` | Ninguna; límite por IP | Registrar el teléfono al primer arranque | `201 { deviceId, token }` | 1 |
| `PATCH /v1/devices/me` | Token | Push token y versión de la app | `204` | 1 |
| `DELETE /v1/devices/me` | Token | Borrar el dispositivo, su casa y todo lo asociado | `204` | 1 |
| `POST /v1/homes` | Token | "Este teléfono vigila mi casa": crea la casa del dispositivo | `201 { homeId, shareCode }` | 1 |
| `PATCH /v1/homes/me` | Token | Alias y modo (`base` o `ups`) | `204` | 1 |
| `GET /v1/homes/me/status` | Token | Estado actual de mi casa | `HomeStatus` | 1 |
| `GET /v1/homes/me/outages?from&to` | Token | Historial con resumen por día | `{ items, reports, totalMs, days }` | 2 |
| `POST /v1/homes/me/share-code` | Token | Regenerar el código | `{ shareCode }` | 3 |
| `POST /v1/events` | Token | Lote de eventos (hasta 200) o latido vacío | `{ accepted, duplicated, status }` | 1 |
| `POST /v1/follows` | Token | Seguir una casa con su código | `201 { homeId, alias, status }` | 3 |
| `GET /v1/follows` | Token | Casas que sigo, con su estado | `{ items }` | 3 |
| `DELETE /v1/follows/:homeId` | Token | Dejar de seguir | `204` | 3 |
| `GET /c/:code` | Pública; límite por IP; caché 30 s | Página HTML de la familia | HTML | 3 |
| `GET /privacidad` | Pública | Política de privacidad | HTML | 2 |
| `GET /borrar-datos` | Pública | Cómo borrar los datos desde la app o por correo (lo pide el formulario de Play) | HTML | 2 |
| `GET /.well-known/assetlinks.json` | Pública | Abrir `/c/:code` dentro de la app (App Links) | JSON | 3 |
| `GET /health` | Pública | Monitoreo | `{ ok: true }` | 1 |
| `GET /openapi.json` | Pública | Contrato para generar el cliente de la app | JSON | 1 |
| `GET /docs` | Pública solo en staging | Referencia navegable (Scalar) | HTML | 1 |

Errores: `{ error: { code, message } }`.

| HTTP | `code` |
| --- | --- |
| 400 | `validation_failed` (incluye `issues` de Zod) |
| 401 | `invalid_token` |
| 404 | `not_found` (por ejemplo, un código inexistente) |
| 409 | `home_exists` (el dispositivo ya vigila una casa) |
| 429 | `rate_limited` (incluye la cabecera `Retry-After: 60`) |
| 500 | `internal_error` (mensaje genérico; el error real va al log, sin cabeceras ni cuerpo y con el token tapado) |

Una ruta que no existe también responde `404 not_found`, y un cuerpo que no es JSON, `400 validation_failed` con `issues` vacío.

## Contrato de eventos

```ts
// src/domain/events/schema.ts
import { z } from '@hono/zod-openapi'; // el z de Zod 4 con .openapi()

export const epochMs = z.number().int().positive();

export const snapshotSourceSchema = z.enum([
  'network_callback', 'heartbeat', 'charging_job', 'power_receiver',
  'transition_check', 'app_open', 'boot',
]);

export const snapshotEventSchema = z.object({
  kind: z.literal('snapshot'),
  id: z.uuid(),                       // uuid v7 del teléfono: clave de idempotencia
  at: epochMs,                        // reloj del teléfono
  source: snapshotSourceSchema,
  plugged: z.boolean(),
  onWifi: z.boolean(),
  homeWifi: z.boolean().nullable(),
  internet: z.boolean().nullable(),
  interactive: z.boolean().nullable(),
  batteryPct: z.number().int().min(0).max(100).nullable(),
});

export const reportEventSchema = z.object({
  kind: z.literal('report'),
  id: z.uuid(),
  at: epochMs,
  value: z.enum(['hay_luz', 'fluctuando', 'sin_luz']),
});

export const confirmationEventSchema = z.object({
  kind: z.literal('confirmation'),
  id: z.uuid(),
  at: epochMs,
  outageStart: epochMs,               // el teléfono no conoce el id del servidor
  answer: z.boolean(),
});

export const deviceEventSchema = z.discriminatedUnion('kind', [
  snapshotEventSchema, reportEventSchema, confirmationEventSchema,
]);

export const diagnosticsSchema = z.object({
  appVersion: z.string(),
  manufacturer: z.string(),
  model: z.string(),
  sdkInt: z.number().int(),
  standbyBucket: z.number().int().nullable(),   // UsageStatsManager.getAppStandbyBucket()
  ignoringBatteryOptimizations: z.boolean(),
  pendingEvents: z.number().int().min(0),
});

export const eventBatchSchema = z.object({
  sentAt: epochMs,                    // para corregir el desfase de reloj
  diagnostics: diagnosticsSchema,
  events: z.array(deviceEventSchema).max(200), // vacío = solo latido
});

export type DeviceEvent = z.infer<typeof deviceEventSchema>;
export type SnapshotEvent = z.infer<typeof snapshotEventSchema>;
export type EventBatch = z.infer<typeof eventBatchSchema>;
```

```ts
// src/domain/homes/schema.ts
export const homeStatusSchema = z.object({
  state: z.enum(['con_luz', 'sin_luz', 'sin_noticias']),
  since: epochMs,
  alias: z.string(),
  openOutageStart: epochMs.nullable(),
});
export type HomeStatus = z.infer<typeof homeStatusSchema>;
```

Kotlin arma el JSON a mano. Para que no se desvíe del contrato, el test de contrato valida con `eventBatchSchema` un lote real capturado del teléfono (`test/fixtures/`). Cada versión de la app que llegue a Play deja su lote ahí, y los cambios del contrato tienen que seguir aceptándolos: solo se hacen cambios aditivos en `/v1`.

## Qué hace `POST /v1/events`

1. Autentica y registra el latido en una sola consulta: `UPDATE app.devices SET last_seen_at = $now, diagnostics = $diag WHERE token_hash = $hash RETURNING id, home_id`.
2. Valida con `eventBatchSchema`.
3. Si el lote viene vacío, responde con el estado de la casa y termina.
4. Calcula `offset = receivedAt − sentAt` y llama a `app.ingest_batch(device_id, home_id, events, offset, receivedAt)`. La función guarda cada evento con `device_at` sin tocar y `at = device_at + offset`, inserta con `ON CONFLICT (device_id, id) DO NOTHING` y devuelve `accepted`, `duplicated`, la revisión de la casa, la ventana y los cortes guardados que hay que reconciliar. La ventana está definida en `data-model.md` ("Funciones de ingesta").
5. En el Worker corren `classify`, `reconcileOutages` y `deriveHomeStatus`.
6. `app.apply_outages(home_id, revision, cambios, estado, now)` aplica todo en una transacción, solo si la revisión no cambió (A-016), y devuelve el estado de la casa. Los push de los cortes que se cierran se encolan con `ctx.waitUntil` (fase 3).

## Límites de peticiones

Muchos usuarios de CANTV, Digitel y Movistar comparten IP (CGNAT), y cuando vuelve la luz en una zona todos suben a la vez. Por eso se limita por token siempre que se puede y el límite por IP es holgado.

| Ruta | Clave | Límite |
| --- | --- | --- |
| `POST /v1/devices` | IP | 5 por minuto (A-014) |
| `POST /v1/events` | Dispositivo | 30 por minuto |
| Resto con token | Dispositivo | 120 por minuto |
| `GET /c/:code` | IP | 60 por minuto, con caché de 30 s |

Se usa el binding Rate Limiting de Workers, con clave por dispositivo, o por IP en las rutas públicas (A-009). El binding solo admite periodos de 10 o 60 segundos. La clave por dispositivo es el SHA-256 del token, así que el límite corre antes de tocar la base, y sin token la petición responde 401 sin consultarla. El teléfono espera entre 0 y 60 segundos al azar antes de subir tras recuperar la red, para no llegar todos en el mismo segundo.

## Cuándo sale cada push

| Push | A quién | Cuándo | Texto |
| --- | --- | --- | --- |
| Inicio | Seguidores | Cron `sweep`, cada 5 min: corte `abierto` de `MIN_OUTAGE_MS` o más, sin `start_notified_at`, conocido hace 30 min o menos | "Se fue la luz en Casa de mamá (6:05 p. m.)" |
| Regreso | Seguidores | Al cerrarse como `cerrado`, si hubo push de inicio | "Volvió la luz en Casa de mamá tras 2 h 10 min" |
| Resumen tardío | Seguidores | Al cerrarse como `cerrado` sin push de inicio (el teléfono no tenía datos) | "En Casa de mamá se fue la luz de 6:05 a 8:15 p. m. (2 h 10 min)" |
| Confirmación | Teléfono de la casa | Al cerrarse: siempre con confianza `media`; con `alta`, durante el piloto, máximo 2 al día | "¿Se fue la luz de 6:05 a 8:15 p. m.?" con botones Sí y No |

"Sin noticias" no genera push en la v1: la familia lo ve al abrir la app o el enlace. El cron `sweep` lee los recibos de Expo Push y borra los `push_token` que respondan `DeviceNotRegistered`.

Amenazas y privacidad en `pulso-app/docs/security-privacy.md`.
