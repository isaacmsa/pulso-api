CREATE SCHEMA "app";
--> statement-breakpoint
CREATE TABLE "app"."devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"home_id" uuid,
	"push_token" text,
	"app_version" text NOT NULL,
	"diagnostics" jsonb,
	"created_at" bigint NOT NULL,
	"last_seen_at" bigint NOT NULL,
	CONSTRAINT "devices_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "app"."devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."events" (
	"device_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"home_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"device_at" bigint NOT NULL,
	"at" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" bigint NOT NULL,
	CONSTRAINT "events_device_id_id_pk" PRIMARY KEY("device_id","id"),
	CONSTRAINT "events_kind_check" CHECK ("app"."events"."kind" IN ('snapshot','report','confirmation'))
);
--> statement-breakpoint
ALTER TABLE "app"."events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."follows" (
	"home_id" uuid NOT NULL,
	"follower_device_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "follows_home_id_follower_device_id_pk" PRIMARY KEY("home_id","follower_device_id")
);
--> statement-breakpoint
ALTER TABLE "app"."follows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."homes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"share_code" text NOT NULL,
	"alias" text DEFAULT 'Casa' NOT NULL,
	"mode" text DEFAULT 'base' NOT NULL,
	"status" text DEFAULT 'con_luz' NOT NULL,
	"status_since" bigint NOT NULL,
	"ingest_revision" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "homes_share_code_unique" UNIQUE("share_code"),
	CONSTRAINT "homes_mode_check" CHECK ("app"."homes"."mode" IN ('base','ups')),
	CONSTRAINT "homes_status_check" CHECK ("app"."homes"."status" IN ('con_luz','sin_luz','sin_noticias'))
);
--> statement-breakpoint
ALTER TABLE "app"."homes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."outages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"home_id" uuid NOT NULL,
	"started_at" bigint NOT NULL,
	"ended_at" bigint,
	"status" text NOT NULL,
	"confidence" text NOT NULL,
	"confirmed" boolean,
	"start_notified_at" bigint,
	"end_notified_at" bigint,
	"confirm_asked_at" bigint,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "outages_status_check" CHECK ("app"."outages"."status" IN ('abierto','cerrado','descartado','sin_datos')),
	CONSTRAINT "outages_confidence_check" CHECK ("app"."outages"."confidence" IN ('alta','media','manual'))
);
--> statement-breakpoint
ALTER TABLE "app"."outages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."push_tickets" (
	"ticket_id" text PRIMARY KEY NOT NULL,
	"device_id" uuid NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."push_tickets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."devices" ADD CONSTRAINT "devices_home_id_homes_id_fk" FOREIGN KEY ("home_id") REFERENCES "app"."homes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."events" ADD CONSTRAINT "events_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "app"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."events" ADD CONSTRAINT "events_home_id_homes_id_fk" FOREIGN KEY ("home_id") REFERENCES "app"."homes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."follows" ADD CONSTRAINT "follows_home_id_homes_id_fk" FOREIGN KEY ("home_id") REFERENCES "app"."homes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."follows" ADD CONSTRAINT "follows_follower_device_id_devices_id_fk" FOREIGN KEY ("follower_device_id") REFERENCES "app"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."outages" ADD CONSTRAINT "outages_home_id_homes_id_fk" FOREIGN KEY ("home_id") REFERENCES "app"."homes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."push_tickets" ADD CONSTRAINT "push_tickets_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "app"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "devices_home" ON "app"."devices" USING btree ("home_id");--> statement-breakpoint
CREATE INDEX "devices_last_seen" ON "app"."devices" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "events_home_at" ON "app"."events" USING btree ("home_id","at");--> statement-breakpoint
CREATE INDEX "follows_follower" ON "app"."follows" USING btree ("follower_device_id");--> statement-breakpoint
CREATE INDEX "outages_home_started" ON "app"."outages" USING btree ("home_id","started_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "outages_open" ON "app"."outages" USING btree ("home_id") WHERE "app"."outages"."status" = 'abierto';