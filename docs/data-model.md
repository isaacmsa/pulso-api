# Modelo de datos

**Qué responde este documento**

- Qué tablas tiene PostgreSQL y por qué
- Qué funciones de PostgreSQL hacen la ingesta y cómo se protegen los datos en Supabase
- Cómo se evitan duplicados y se corrige el reloj del teléfono
- Cuánto tiempo vive cada dato y cuánto escribe cada teléfono

Seis tablas en PostgreSQL (Supabase), en el esquema `app`. Ninguna guarda nombre, teléfono, correo, ubicación ni nombre de la red.

La fuente es `src/db/schema.ts` (Drizzle). `drizzle-kit generate` produce el SQL en `drizzle/`, y ese SQL es lo que se revisa en cada PR. El esquema equivalente:

```sql
-- drizzle/0000_init.sql (equivalente; el archivo real lo genera drizzle-kit)
CREATE SCHEMA app AUTHORIZATION pulso_api;   -- el rol se crea a mano una vez por proyecto

CREATE TABLE app.homes (
  id                 uuid PRIMARY KEY,                       -- uuid v7 generado en la API
  share_code         text NOT NULL UNIQUE,                   -- 8 caracteres de 23456789ABCDEFGHJKMNPQRSTUVWXYZ
  alias              text NOT NULL DEFAULT 'Casa',
  mode               text NOT NULL DEFAULT 'base' CHECK (mode IN ('base','ups')),
  status             text NOT NULL DEFAULT 'con_luz'
                     CHECK (status IN ('con_luz','sin_luz','sin_noticias')),
  status_since       bigint NOT NULL,                        -- epoch ms
  created_at         bigint NOT NULL
);

CREATE TABLE app.devices (
  id            uuid PRIMARY KEY,
  token_hash    text NOT NULL UNIQUE,                        -- sha-256 hex del token
  home_id       uuid REFERENCES app.homes(id) ON DELETE SET NULL, -- NULL = solo sigue casas
  push_token    text,
  app_version   text NOT NULL,
  diagnostics   jsonb,                                       -- último diagnóstico recibido
  created_at    bigint NOT NULL,
  last_seen_at  bigint NOT NULL                              -- último latido o petición
);
CREATE INDEX devices_home ON app.devices (home_id);
CREATE INDEX devices_last_seen ON app.devices (last_seen_at);

CREATE TABLE app.events (
  device_id    uuid NOT NULL REFERENCES app.devices(id) ON DELETE CASCADE,
  id           uuid NOT NULL,                                -- uuid v7 generado en el teléfono
  home_id      uuid NOT NULL REFERENCES app.homes(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('snapshot','report','confirmation')),
  device_at    bigint NOT NULL,                              -- hora original del teléfono, sin tocar
  at           bigint NOT NULL,                              -- device_at + desfase del lote
  payload      jsonb NOT NULL,                               -- validado por Zod
  received_at  bigint NOT NULL,
  PRIMARY KEY (device_id, id)                                -- reintentos idempotentes
);
CREATE INDEX events_home_at ON app.events (home_id, at);

CREATE TABLE app.outages (
  id                 uuid PRIMARY KEY,
  home_id            uuid NOT NULL REFERENCES app.homes(id) ON DELETE CASCADE,
  started_at         bigint NOT NULL,
  ended_at           bigint,                                 -- NULL = en curso
  status             text NOT NULL
                     CHECK (status IN ('abierto','cerrado','descartado','sin_datos')),
  confidence         text NOT NULL CHECK (confidence IN ('alta','media','manual')),
  confirmed          boolean,                                -- NULL sin respuesta
  start_notified_at  bigint,                                 -- push de inicio enviado
  end_notified_at    bigint,                                 -- push de regreso enviado
  confirm_asked_at   bigint,                                 -- confirmación pedida
  updated_at         bigint NOT NULL
);
CREATE INDEX outages_home_started ON app.outages (home_id, started_at DESC);
CREATE INDEX outages_open ON app.outages (home_id) WHERE status = 'abierto';

CREATE TABLE app.follows (
  home_id             uuid NOT NULL REFERENCES app.homes(id) ON DELETE CASCADE,
  follower_device_id  uuid NOT NULL REFERENCES app.devices(id) ON DELETE CASCADE,
  alias               text NOT NULL,                         -- "Casa de mamá"
  created_at          bigint NOT NULL,
  PRIMARY KEY (home_id, follower_device_id)
);
CREATE INDEX follows_follower ON app.follows (follower_device_id);

CREATE TABLE app.push_tickets (
  ticket_id   text PRIMARY KEY,                              -- ticket de Expo Push
  device_id   uuid NOT NULL REFERENCES app.devices(id) ON DELETE CASCADE,
  created_at  bigint NOT NULL
);

-- Supabase expone `public` en su API REST; `app` no. Además, RLS sin políticas (A-005).
ALTER TABLE app.homes ENABLE ROW LEVEL SECURITY;   -- y lo mismo en las otras cinco tablas
-- El esquema y las tablas son de `pulso_api` (las migraciones corren con ese rol).
-- El dueño no pasa por RLS; `anon`, `authenticated` y cualquier otro rol no ven nada.
```

## Por qué así

- **La casa y el teléfono son tablas distintas.** Un familiar que solo sigue casas es un `device` sin `home_id`. Así caben, sin migrar, un iPhone que solo sigue (v1.1) y, más adelante, dos teléfonos en una casa.
- **La clave de idempotencia es el `id` del evento**, un UUID v7 que genera el teléfono. Un reintento con otro `sentAt` no duplica nada.
- **La hora original no se toca.** `device_at` queda igual que la mandó el teléfono, y `at` es la hora corregida con el desfase del lote (`receivedAt − sentAt`). El clasificador usa `at`.
- **Horas en `bigint` (epoch ms)**, igual que en el contrato y en el clasificador (A-005). Para mirar a mano: `to_timestamp(at / 1000.0) AT TIME ZONE 'America/Caracas'`.
- **`payload` en `jsonb`** (A-004): los campos del snapshot van a cambiar con la prueba técnica. Zod valida la forma en la entrada, así que agregar un campo no exige migración.
- **El estado de la casa vive materializado** en `homes.status`. La página pública lee una fila, y el push compara el estado anterior con el nuevo para avisar solo en las transiciones.
- **Los avisos quedan marcados en `outages`** (`start_notified_at`, `end_notified_at`, `confirm_asked_at`) con un `UPDATE … WHERE start_notified_at IS NULL RETURNING`, antes de enviar. Solo quien gana esa actualización manda el push, así que no se repite aunque el cron corra dos veces.
- **La ingesta va en funciones de PostgreSQL** (A-004), para gastar pocas consultas de Hyperdrive y que cada paso sea atómico:
  - `app.ingest_batch(device_id, events jsonb, offset_ms)`: inserta los eventos con `ON CONFLICT DO NOTHING` y devuelve `accepted`, `duplicated`, el modo de la casa, la ventana de eventos y los cortes abiertos.
  - `app.apply_outages(home_id, outages jsonb, status jsonb)`: aplica en una transacción lo que decidió `reconcileOutages` y el nuevo `homes.status`.
  - El clasificador no está en SQL: corre en el Worker entre las dos llamadas.

## Retención

| Dato | Se guarda | Cómo se borra |
| --- | --- | --- |
| `events` | 30 días | Cron `retention`, diario a las 4:00 a. m. de Caracas |
| `outages` | Mientras exista la casa | Al borrar la casa (cascada) |
| `devices` sin actividad | 180 días sin `last_seen_at` | Cron `retention`, en cascada |
| `devices` registrados que nunca mandaron nada | 7 días | Cron `retention` |
| `push_tickets` | Hasta leer el recibo (unos 15 min) | Cron `sweep` |

Un corte `abierto` que pasa 24 horas sin eventos nuevos de su casa queda `sin_datos` y no suma horas sin luz.

## Volumen

El teléfono sube un snapshot solo si cambió `(plugged, onWifi, homeWifi, internet)` (D-008 del producto). El latido viaja aunque no haya cambios, pero es una sola consulta: el mismo `UPDATE` que autentica.

| Por teléfono que vigila una casa, por día | Peticiones | Consultas por Hyperdrive | Filas nuevas |
| --- | --- | --- | --- |
| Latidos (96 de 15 min) | 96 | 96 | 0 |
| Lotes con cambios y reportes | ~20 | ~60 (auth, `ingest_batch`, `apply_outages`) | ~10 a 30 |
| Cron (repartido entre todas las casas) | | ~1 | |
| **Total** | **~116** | **~157** | **~20** |

Con el plan gratuito de Hyperdrive (100.000 consultas al día) eso da **~640 teléfonos**. Las peticiones de las familias (estado, historial, `/c/:code`) suman algo más, así que el techo práctico ronda los 500 a 600. Antes de llegar ahí: Workers Paid (USD 5 al mes).

Con 1.000 teléfonos, `events` crecería ~20.000 filas al día. Con 30 días de retención son ~600.000 filas, unos 250 a 300 MB con índices, dentro de los 500 MB de Supabase gratis.
