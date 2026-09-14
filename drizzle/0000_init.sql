CREATE TABLE "alert_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" integer NOT NULL,
	"price" numeric(18, 4) NOT NULL,
	"triggered_at" timestamp with time zone NOT NULL,
	"cleared_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	CONSTRAINT "alert_events_order_ck" CHECK ("alert_events"."cleared_at" is null or "alert_events"."cleared_at" >= "alert_events"."triggered_at")
);
--> statement-breakpoint
CREATE TABLE "daily_bars" (
	"security_id" integer NOT NULL,
	"date" date NOT NULL,
	"open" numeric(18, 4),
	"high" numeric(18, 4),
	"low" numeric(18, 4),
	"close" numeric(18, 4),
	"tick_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "daily_bars_security_id_date_pk" PRIMARY KEY("security_id","date")
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"security_id" integer PRIMARY KEY NOT NULL,
	"avg_cost" numeric(18, 4),
	"shares" numeric(20, 6)
);
--> statement-breakpoint
CREATE TABLE "price_ticks" (
	"security_id" integer NOT NULL,
	"price" numeric(18, 4) NOT NULL,
	"provider" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"quote_at" timestamp with time zone,
	CONSTRAINT "price_ticks_security_id_captured_at_pk" PRIMARY KEY("security_id","captured_at"),
	CONSTRAINT "price_ticks_positive_ck" CHECK ("price_ticks"."price" > 0)
);
--> statement-breakpoint
CREATE TABLE "securities" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"name" text NOT NULL,
	"cik" text,
	"active" boolean DEFAULT true NOT NULL,
	"maint_pct" numeric(9, 6) DEFAULT 0.7 NOT NULL,
	"growth_rate" numeric(9, 6),
	"fcf_per_share" numeric(18, 4),
	"marr" numeric(9, 6) DEFAULT 0.15 NOT NULL,
	"mos_pct" numeric(9, 6) DEFAULT 0.5 NOT NULL,
	"pbt_years" integer DEFAULT 8 NOT NULL,
	CONSTRAINT "securities_ticker_unique" UNIQUE("ticker")
);
--> statement-breakpoint
CREATE TABLE "valuations" (
	"id" serial PRIMARY KEY NOT NULL,
	"security_id" integer NOT NULL,
	"method" text NOT NULL,
	"buy_price" numeric(18, 4) NOT NULL,
	"sticker_price" numeric(18, 4) NOT NULL,
	"growth_rate" numeric(9, 6),
	"marr" numeric(9, 6),
	"mos_pct" numeric(9, 6),
	"inputs" jsonb,
	"source" text NOT NULL,
	"as_of" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "valuations_method_ck" CHECK ("valuations"."method" in ('pbt','mos','ten_cap')),
	CONSTRAINT "valuations_source_ck" CHECK ("valuations"."source" in ('manual','engine')),
	CONSTRAINT "valuations_positive_ck" CHECK ("valuations"."buy_price" > 0 and "valuations"."sticker_price" > 0)
);
--> statement-breakpoint
CREATE TABLE "watch_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"security_id" integer NOT NULL,
	"kind" text NOT NULL,
	"value" numeric(18, 4),
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "watch_rules_kind_ck" CHECK ("watch_rules"."kind" in ('safe','buy')),
	CONSTRAINT "watch_rules_safe_needs_value_ck" CHECK ("watch_rules"."kind" <> 'safe' or "watch_rules"."value" is not null)
);
--> statement-breakpoint
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_rule_id_watch_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."watch_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_bars" ADD CONSTRAINT "daily_bars_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."securities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."securities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_ticks" ADD CONSTRAINT "price_ticks_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."securities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "valuations" ADD CONSTRAINT "valuations_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."securities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_rules" ADD CONSTRAINT "watch_rules_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."securities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_events_one_open_per_rule" ON "alert_events" USING btree ("rule_id") WHERE "alert_events"."cleared_at" is null;--> statement-breakpoint
CREATE INDEX "price_ticks_recent_idx" ON "price_ticks" USING btree ("security_id","captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "valuations_latest_idx" ON "valuations" USING btree ("security_id","method","as_of" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "watch_rules_security_kind_uq" ON "watch_rules" USING btree ("security_id","kind");