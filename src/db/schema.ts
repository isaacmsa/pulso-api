import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';

// Se exporta para que drizzle-kit emita CREATE SCHEMA.
// Todo Pulso vive en el esquema `app`, nunca en `public` (Supabase expone `public` en su API REST).
// RLS activado y sin políticas (A-005): solo el dueño, `pulso_api`, ve las filas.
export const app = pgSchema('app');

// Las horas son epoch en milisegundos (A-007): caben en un `number`, así que `mode: 'number'`.
const epochMs = (name: string) => bigint(name, { mode: 'number' });

export const homes = app
  .table(
    'homes',
    {
      id: uuid('id').primaryKey(), // uuid v7 generado en la API
      shareCode: text('share_code').notNull().unique(), // 8 caracteres de 23456789ABCDEFGHJKMNPQRSTUVWXYZ
      alias: text('alias').notNull().default('Casa'),
      mode: text('mode').notNull().default('base'),
      status: text('status').notNull().default('con_luz'),
      statusSince: epochMs('status_since').notNull(),
      // A-016: ingest_batch la sube y apply_outages solo aplica si no cambió
      ingestRevision: bigint('ingest_revision', { mode: 'number' }).notNull().default(0),
      // A-024: el ancla más vieja que ingest_batch guardó y ningún apply_outages aplicó; NULL = nada pendiente
      pendingAnchor: epochMs('pending_anchor'),
      createdAt: epochMs('created_at').notNull(),
    },
    (t) => [
      check('homes_mode_check', sql`${t.mode} IN ('base','ups')`),
      check('homes_status_check', sql`${t.status} IN ('con_luz','sin_luz','sin_noticias')`),
    ],
  )
  .enableRLS();

export const devices = app
  .table(
    'devices',
    {
      id: uuid('id').primaryKey(),
      tokenHash: text('token_hash').notNull().unique(), // sha-256 hex del token
      homeId: uuid('home_id').references(() => homes.id, { onDelete: 'set null' }), // NULL = solo sigue casas
      pushToken: text('push_token'),
      appVersion: text('app_version').notNull(),
      diagnostics: jsonb('diagnostics'), // último diagnóstico recibido
      createdAt: epochMs('created_at').notNull(),
      lastSeenAt: epochMs('last_seen_at').notNull(), // último latido o petición
    },
    (t) => [index('devices_home').on(t.homeId), index('devices_last_seen').on(t.lastSeenAt)],
  )
  .enableRLS();

export const events = app
  .table(
    'events',
    {
      deviceId: uuid('device_id')
        .notNull()
        .references(() => devices.id, { onDelete: 'cascade' }),
      id: uuid('id').notNull(), // uuid v7 generado en el teléfono
      homeId: uuid('home_id')
        .notNull()
        .references(() => homes.id, { onDelete: 'cascade' }),
      kind: text('kind').notNull(),
      deviceAt: epochMs('device_at').notNull(), // hora original del teléfono, sin tocar
      at: epochMs('at').notNull(), // device_at + desfase del lote
      payload: jsonb('payload').notNull(), // validado por Zod
      receivedAt: epochMs('received_at').notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.deviceId, t.id] }), // reintentos idempotentes
      check('events_kind_check', sql`${t.kind} IN ('snapshot','report','confirmation')`),
      index('events_home_at').on(t.homeId, t.at),
    ],
  )
  .enableRLS();

export const outages = app
  .table(
    'outages',
    {
      id: uuid('id').primaryKey(),
      homeId: uuid('home_id')
        .notNull()
        .references(() => homes.id, { onDelete: 'cascade' }),
      startedAt: epochMs('started_at').notNull(),
      endedAt: epochMs('ended_at'), // NULL = en curso
      status: text('status').notNull(),
      confidence: text('confidence').notNull(),
      confirmed: boolean('confirmed'), // NULL sin respuesta
      startNotifiedAt: epochMs('start_notified_at'), // push de inicio enviado
      endNotifiedAt: epochMs('end_notified_at'), // push de regreso enviado
      confirmAskedAt: epochMs('confirm_asked_at'), // confirmación pedida
      updatedAt: epochMs('updated_at').notNull(),
      // A-033: cuándo lo conoció el servidor (el insert de apply_outages); NULL en las filas de antes de 0003
      createdAt: epochMs('created_at'),
    },
    (t) => [
      check(
        'outages_status_check',
        sql`${t.status} IN ('abierto','cerrado','descartado','sin_datos')`,
      ),
      check('outages_confidence_check', sql`${t.confidence} IN ('alta','media','manual')`),
      index('outages_home_started').on(t.homeId, t.startedAt.desc().nullsFirst()), // DESC NULLS FIRST es el DESC por defecto: sirve a ORDER BY started_at DESC
      index('outages_open').on(t.homeId).where(sql`${t.status} = 'abierto'`),
    ],
  )
  .enableRLS();

export const follows = app
  .table(
    'follows',
    {
      homeId: uuid('home_id')
        .notNull()
        .references(() => homes.id, { onDelete: 'cascade' }),
      followerDeviceId: uuid('follower_device_id')
        .notNull()
        .references(() => devices.id, { onDelete: 'cascade' }),
      alias: text('alias').notNull(), // "Casa de mamá"
      createdAt: epochMs('created_at').notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.homeId, t.followerDeviceId] }),
      index('follows_follower').on(t.followerDeviceId),
    ],
  )
  .enableRLS();

export const pushTickets = app
  .table('push_tickets', {
    ticketId: text('ticket_id').primaryKey(), // ticket de Expo Push
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    createdAt: epochMs('created_at').notNull(),
  })
  .enableRLS();
